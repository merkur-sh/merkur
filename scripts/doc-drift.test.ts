import { expect, test } from 'bun:test';

import {
  extractDriftTokens,
  extractPathTokens,
  formatFinding,
  grepProse,
  splitDiffByFile,
} from './doc-drift';

const DIFF = `diff --git a/packages/shared/src/transport.ts b/packages/shared/src/transport.ts
--- a/packages/shared/src/transport.ts
+++ b/packages/shared/src/transport.ts
@@ -10 +10 @@
-export const TRANSPORT_CHANNEL_ID = 7;
+export const TRANSPORT_CHANNEL_ID = 8;
@@ -20,2 +20 @@
-export function oldHelper(): void {}
-export const MOVED_NAME = 1;
@@ -30 +29 @@
+export const MOVED_NAME = 1;
diff --git a/apps/daemon/dataplane/src/ipc/commands.rs b/apps/daemon/dataplane/src/ipc/commands.rs
--- a/apps/daemon/dataplane/src/ipc/commands.rs
+++ b/apps/daemon/dataplane/src/ipc/commands.rs
@@ -5,2 +5 @@
-    pub session_token_ttl: u64,
-pub fn legacy_entry() {}
@@ -40 +39 @@
-pub const ROW_RESEND_MAX_MS: f64 = 400.0;
+pub const ROW_RESEND_MAX_MS: f64 = 250.0;
diff --git a/apps/daemon/src/services/dataplane-client.ts b/apps/daemon/src/services/dataplane-client.ts
--- a/apps/daemon/src/services/dataplane-client.ts
+++ b/apps/daemon/src/services/dataplane-client.ts
@@ -12 +12 @@
-  type: 'stun_probe_started',
+  type: 'stun_probe_begun',
@@ -14 +14 @@
-  'kept_key',
+  'kept_key',
diff --git a/packages/config/src/server-config.ts b/packages/config/src/server-config.ts
--- a/packages/config/src/server-config.ts
+++ b/packages/config/src/server-config.ts
@@ -50 +50 @@
-    const legacy = yield* Config.string('LEGACY_FLAG');
+    const level = process.env.LOG_LEVEL;
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -30,2 +30,2 @@
-    "check:old": "bun run scripts/old.ts",
-    "check": "bun run check:types && bun run check:lint",
+    "check": "bun run check:types && bun run check:lint && bun run check:docs",
+    "check:docs": "bun run scripts/check-docs.ts",
diff --git a/apps/server/.env.example b/apps/server/.env.example
--- a/apps/server/.env.example
+++ b/apps/server/.env.example
@@ -3 +3 @@
-OLD_ENV_KEY=
+NEW_ENV_KEY=
diff --git a/apps/web/src/session/lanes.ts b/apps/web/src/session/lanes.ts
--- a/apps/web/src/session/lanes.ts
+++ b/apps/web/src/session/lanes.ts
@@ -8 +8 @@
-  const existing = this.controllers.get(channelId);
+  const existing = this.controllers.get(laneKey);
diff --git a/apps/web/src/session/lanes.test.ts b/apps/web/src/session/lanes.test.ts
--- a/apps/web/src/session/lanes.test.ts
+++ b/apps/web/src/session/lanes.test.ts
@@ -1 +0,0 @@
-export const FIXTURE_ONLY = 1;
`;

test('splitDiffByFile groups removed and added lines by path', () => {
  const files = splitDiffByFile(DIFF);
  expect(files.map((file) => file.path)).toEqual([
    'packages/shared/src/transport.ts',
    'apps/daemon/dataplane/src/ipc/commands.rs',
    'apps/daemon/src/services/dataplane-client.ts',
    'packages/config/src/server-config.ts',
    'package.json',
    'apps/server/.env.example',
    'apps/web/src/session/lanes.ts',
    'apps/web/src/session/lanes.test.ts',
  ]);
  expect(files[0]?.removed).toEqual([
    'export const TRANSPORT_CHANNEL_ID = 7;',
    'export function oldHelper(): void {}',
    'export const MOVED_NAME = 1;',
  ]);
  expect(files[0]?.added).toEqual([
    'export const TRANSPORT_CHANNEL_ID = 8;',
    'export const MOVED_NAME = 1;',
  ]);
});

test('extractDriftTokens finds removed exports, pub items, serde fields, IPC keys, env names, scripts, and changed literals', () => {
  const tokens = extractDriftTokens(DIFF).map(
    (token) => `${token.kind} ${token.token} @ ${token.path} (${token.change})`,
  );
  expect(tokens).toEqual([
    'export oldHelper @ packages/shared/src/transport.ts (removed)',
    'literal TRANSPORT_CHANNEL_ID @ packages/shared/src/transport.ts (7 → 8)',
    'pub legacy_entry @ apps/daemon/dataplane/src/ipc/commands.rs (removed)',
    'serde-field session_token_ttl @ apps/daemon/dataplane/src/ipc/commands.rs (removed)',
    'literal ROW_RESEND_MAX_MS @ apps/daemon/dataplane/src/ipc/commands.rs (400.0 → 250.0)',
    'ipc-key stun_probe_started @ apps/daemon/src/services/dataplane-client.ts (removed)',
    'env LEGACY_FLAG @ packages/config/src/server-config.ts (removed)',
    'script check:old @ package.json (removed)',
    'script-command check @ package.json (command changed: bun run check:types && bun run check:lint → bun run check:types && bun run check:lint && bun run check:docs)',
    'env OLD_ENV_KEY @ apps/server/.env.example (removed)',
  ]);
});

test('a name that moved within a file is not reported as removed', () => {
  const tokens = extractDriftTokens(DIFF);
  expect(tokens.some((token) => token.token === 'MOVED_NAME')).toBe(false);
  expect(tokens.some((token) => token.token === 'kept_key')).toBe(false);
});

test('local lower-case bindings and test-file fixtures are not drift tokens', () => {
  const tokens = extractDriftTokens(DIFF);
  expect(tokens.some((token) => token.token === 'existing')).toBe(false);
  expect(tokens.some((token) => token.token === 'FIXTURE_ONLY')).toBe(false);
});

test('extractPathTokens reads deleted and renamed paths from --name-status', () => {
  const tokens = extractPathTokens(
    ['D\tdocs/old-guide.md', 'R100\tscripts/a.ts\tscripts/b.ts', 'M\tREADME.md', ''].join('\n'),
  );
  expect(tokens).toEqual([
    { token: 'docs/old-guide.md', kind: 'path', path: 'docs/old-guide.md', change: 'deleted' },
    {
      token: 'scripts/a.ts',
      kind: 'path',
      path: 'scripts/a.ts',
      change: 'renamed to scripts/b.ts',
    },
  ]);
});

test('grepProse matches whole words only and skips fenced code', () => {
  const tokens = extractDriftTokens(DIFF);
  const docs = [
    {
      file: 'AGENTS.md',
      source: [
        'Use `oldHelper` here.',
        'Not oldHelperExtended, nor my-oldHelper.',
        '```',
        'oldHelper in code',
        '```',
        'Run `bun run check:old` and set `LEGACY_FLAG`.',
        'The `TRANSPORT_CHANNEL_ID` lives in packages/shared.',
        'Always check the diff; the word is not the script.',
        'Then run `check` or `bun run check` once.',
      ].join('\n'),
    },
    { file: 'docs/x.md', source: 'stun_probe_started is reported.' },
  ];
  const findings = grepProse(docs, tokens).map(formatFinding);
  expect(findings).toEqual([
    'AGENTS.md:1  oldHelper  (removed in packages/shared/src/transport.ts)',
    'AGENTS.md:6  LEGACY_FLAG  (removed in packages/config/src/server-config.ts)',
    'AGENTS.md:6  check:old  (removed in package.json)',
    'AGENTS.md:7  TRANSPORT_CHANNEL_ID  (changed in packages/shared/src/transport.ts; 7 → 8)',
    'AGENTS.md:9  check  (changed in package.json; command changed: bun run check:types && bun run check:lint → bun run check:types && bun run check:lint && bun run check:docs)',
    'docs/x.md:1  stun_probe_started  (removed in apps/daemon/src/services/dataplane-client.ts)',
  ]);
});

test('a deleted path is matched as a whole path, not as a substring of a longer one', () => {
  const tokens = extractPathTokens('D\tdocs/guide.md\n');
  const docs = [
    {
      file: 'README.md',
      source: 'See [guide](docs/guide.md) but not docs/guide.md.bak or old/docs/guide.md.',
    },
  ];
  expect(grepProse(docs, tokens).map((finding) => finding.line)).toEqual([1]);
  expect(grepProse([{ file: 'x.md', source: 'only docs/guide.md.bak' }], tokens)).toEqual([]);
});
