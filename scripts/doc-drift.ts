import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listProseFiles, proseLines } from './check-docs';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Advisory prose-drift sweep for a code diff.
 *
 * `check:docs` proves specific facts. This script answers the looser question a reviewer
 * asks after a change: "did anything the diff removed or renamed still get mentioned in
 * prose?" It extracts identifiers from `git diff --unified=0 <ref>` over non-Markdown
 * files — removed exports and `pub` items, serde field names under the IPC tree, IPC string
 * keys, environment names, `package.json` script names, changed literal constants, changed
 * script commands, and deleted or renamed paths — then greps the prose set for each as a
 * whole word. Findings are printed, never enforced, unless `--fail` is passed: the Stop hook
 * and the close-the-loop skill surface them for a human to judge.
 */

export type DriftKind =
  | 'export'
  | 'pub'
  | 'serde-field'
  | 'ipc-key'
  | 'env'
  | 'script'
  | 'script-command'
  | 'literal'
  | 'path';

export interface DriftToken {
  readonly token: string;
  readonly kind: DriftKind;
  /** The file the token was removed from or changed in. */
  readonly path: string;
  /** `removed` or a `3 → 4` style change description. */
  readonly change: string;
}

export interface DriftFinding {
  readonly file: string;
  readonly line: number;
  readonly token: DriftToken;
}

const TS_EXPORT =
  /^export (?:declare )?(?:async )?(?:const|let|var|function\*?|class|interface|type|enum|abstract class)\s+([A-Za-z_$][\w$]*)/;
const RUST_PUB =
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|const|static|struct|enum|trait|type|mod|union)\s+([A-Za-z_][\w]*)/;
const SERDE_FIELD = /^\s*pub\s+(?:r#)?([a-z_][a-z0-9_]*)\s*:/;
const SNAKE_STRING = /['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]/g;
const ENV_READ = /(?:process\.env\.|Config\.\w+\(\s*')([A-Z][A-Z0-9_]*)/g;
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/;
const SCRIPT_ENTRY = /^\s*"([\w:@/.-]+)":\s*"(.*)",?\s*$/;
/**
 * A named constant whose value is a literal: `SCREAMING_CASE` on the left, a number, string,
 * or arithmetic on the right. Local `const existing = map.get(key)` bindings are not facts
 * prose can pin, and matching them drowned the real findings in noise.
 */
const LITERAL_ASSIGNMENT =
  /^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)(?:\s*:\s*[\w<>[\]:&' ]+?)?\s*=\s*([\w.'"+\-*/ ]+);/;
/** Test files describe fixtures, not the contract prose documents. */
const TEST_FILE = /(?:\.test\.[jt]sx?$|(?:^|\/)tests\/|(?:^|\/)__tests__\/)/;

const IPC_PATH = /(?:^|\/)ipc(?:\/|-|\.)|dataplane-client/;
const SERDE_PATH = /^apps\/daemon\/dataplane\/src\/ipc\//;
const ENV_FILE = /(?:^|\/)\.env(?:\.|$)/;
const PACKAGE_JSON = /(?:^|\/)package\.json$/;

interface FileHunks {
  readonly path: string;
  readonly removed: string[];
  readonly added: string[];
}

/** Split a unified diff into per-file removed and added lines (without their `-`/`+`). */
export function splitDiffByFile(diff: string): FileHunks[] {
  const files: FileHunks[] = [];
  let current: { path: string; removed: string[]; added: string[] } | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      const name = target === '/dev/null' ? current?.path : target.replace(/^b\//, '');
      if (current !== undefined && name !== undefined) current.path = name;
      continue;
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).trim();
      current = { path: source.replace(/^a\//, ''), removed: [], added: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('-')) current.removed.push(line.slice(1));
    else if (line.startsWith('+')) current.added.push(line.slice(1));
  }
  return files;
}

function firstGroup(pattern: RegExp, line: string): string | undefined {
  return pattern.exec(line)?.[1];
}

function collect(lines: readonly string[], pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const name = firstGroup(pattern, line);
    if (name !== undefined) names.add(name);
  }
  return names;
}

function collectAll(lines: readonly string[], pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

function removedOnly(
  hunks: FileHunks,
  pattern: RegExp,
  kind: DriftKind,
  all = false,
): DriftToken[] {
  const removed = all ? collectAll(hunks.removed, pattern) : collect(hunks.removed, pattern);
  const added = all ? collectAll(hunks.added, pattern) : collect(hunks.added, pattern);
  return [...removed]
    .filter((name) => !added.has(name))
    .map((token) => ({ token, kind, path: hunks.path, change: 'removed' }));
}

function scriptEntries(lines: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines) {
    const match = SCRIPT_ENTRY.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[1], match[2]);
  }
  return entries;
}

function literalEntries(lines: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines) {
    const match = LITERAL_ASSIGNMENT.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(match[1], match[2].trim());
    }
  }
  return entries;
}

/** Identifiers a `--unified=0` diff over non-Markdown files removed or changed. */
export function extractDriftTokens(diff: string): DriftToken[] {
  const tokens: DriftToken[] = [];
  for (const hunks of splitDiffByFile(diff)) {
    const file = hunks.path;
    if (TEST_FILE.test(file)) continue;
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(file))
      tokens.push(...removedOnly(hunks, TS_EXPORT, 'export'));
    if (file.endsWith('.rs')) tokens.push(...removedOnly(hunks, RUST_PUB, 'pub'));
    if (SERDE_PATH.test(file)) tokens.push(...removedOnly(hunks, SERDE_FIELD, 'serde-field'));
    if (IPC_PATH.test(file)) tokens.push(...removedOnly(hunks, SNAKE_STRING, 'ipc-key', true));
    tokens.push(...removedOnly(hunks, ENV_READ, 'env', true));
    if (ENV_FILE.test(file)) tokens.push(...removedOnly(hunks, ENV_ASSIGNMENT, 'env'));

    if (PACKAGE_JSON.test(file)) {
      const before = scriptEntries(hunks.removed);
      const after = scriptEntries(hunks.added);
      for (const [name, command] of before) {
        const next = after.get(name);
        if (next === undefined) {
          tokens.push({ token: name, kind: 'script', path: file, change: 'removed' });
        } else if (next !== command) {
          tokens.push({
            token: name,
            kind: 'script-command',
            path: file,
            change: `command changed: ${command} → ${next}`,
          });
        }
      }
    }

    const before = literalEntries(hunks.removed);
    const after = literalEntries(hunks.added);
    for (const [name, value] of before) {
      const next = after.get(name);
      if (next !== undefined && next !== value) {
        tokens.push({ token: name, kind: 'literal', path: file, change: `${value} → ${next}` });
      }
    }
  }
  return dedupe(tokens);
}

/** Deleted and renamed paths from `git diff --name-status --diff-filter=DR`. */
export function extractPathTokens(nameStatus: string): DriftToken[] {
  const tokens: DriftToken[] = [];
  for (const line of nameStatus.split('\n')) {
    const fields = line.split('\t');
    const status = fields[0]?.trim();
    const from = fields[1];
    if (status === undefined || from === undefined) continue;
    if (status.startsWith('D')) {
      tokens.push({ token: from, kind: 'path', path: from, change: 'deleted' });
    } else if (status.startsWith('R')) {
      tokens.push({
        token: from,
        kind: 'path',
        path: from,
        change: `renamed to ${fields[2] ?? '?'}`,
      });
    }
  }
  return dedupe(tokens);
}

function dedupe(tokens: readonly DriftToken[]): DriftToken[] {
  const seen = new Set<string>();
  const unique: DriftToken[] = [];
  for (const token of tokens) {
    const key = `${token.kind}\0${token.token}\0${token.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
  }
  return unique;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word mentions of each token across the prose files, in file order. */
export function grepProse(
  docs: ReadonlyArray<{ readonly file: string; readonly source: string }>,
  tokens: readonly DriftToken[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  // A script name is an ordinary word (`check`, `dev`, `setup`), so it counts only where
  // prose actually names a script: inside backticks or after `bun run`.
  const patterns = tokens
    .filter((token) => token.token.length >= 3)
    .map((token) => ({
      token,
      pattern:
        token.kind === 'script' || token.kind === 'script-command'
          ? new RegExp(
              `(?:\`(?:bun run (?:--cwd \\S+ )?)?|bun run (?:--cwd \\S+ )?)${escapeRegExp(token.token)}(?=\`|\\s|$)`,
            )
          : new RegExp(`(?<![\\w/.:-])${escapeRegExp(token.token)}(?![\\w:-]|\\.\\w)`),
    }));
  if (patterns.length === 0) return findings;
  for (const doc of docs) {
    for (const { line, text } of proseLines(doc.source)) {
      for (const { token, pattern } of patterns) {
        if (pattern.test(text)) findings.push({ file: doc.file, line, token });
      }
    }
  }
  return findings;
}

export function formatFinding(finding: DriftFinding): string {
  const { token } = finding;
  const verb = token.change === 'removed' || token.change === 'deleted' ? token.change : 'changed';
  const detail = verb === 'changed' ? `; ${token.change}` : '';
  return `${finding.file}:${finding.line}  ${token.token}  (${verb} in ${token.path}${detail})`;
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    process.exit(2);
  }
  return result.stdout.toString();
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sinceIndex = argv.indexOf('--since');
  const since = sinceIndex === -1 ? 'HEAD' : (argv[sinceIndex + 1] ?? 'HEAD');
  const fail = argv.includes('--fail');

  const diff = git(['diff', '--unified=0', since, '--', '.', ':!*.md', ':!**/*.md']);
  const nameStatus = git(['diff', '--name-status', '--diff-filter=DR', since]);
  const tokens = [...extractDriftTokens(diff), ...extractPathTokens(nameStatus)];

  const docs = listProseFiles(ROOT).map((file) => ({
    file,
    source: readFileSync(path.join(ROOT, file), 'utf8'),
  }));
  const findings = grepProse(docs, tokens);

  if (findings.length === 0) {
    process.stdout.write(
      `doc-drift: ${tokens.length} removed/changed identifier(s) since ${since}, none mentioned in prose\n`,
    );
  } else {
    for (const finding of findings) process.stdout.write(`${formatFinding(finding)}\n`);
    process.stdout.write(
      `\ndoc-drift: ${findings.length} prose mention(s) of ${tokens.length} removed/changed identifier(s) since ${since}\n`,
    );
    if (fail) process.exit(1);
  }
}
