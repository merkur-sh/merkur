import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from 'node:fs';
import path from 'node:path';

import { Glob } from 'bun';

import {
  currentServerEnvironmentKeys,
  GENERATED_BLOCKS,
  type GeneratedBlock,
  generatedMarkers,
} from './generate-docs';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Documentation drift gate.
 *
 * Every rule here exists because the prose it checks was measured stale: a codec version
 * one behind the code, an e2e table listing 13 of 17 specs, ten loader keys missing from
 * `.env.example`, three vendored crates absent from the workspace table, five broken
 * links. None of it is path-shaped, so a link checker would have found one of the six.
 *
 * Eight checks, each an exported pure function over text plus injected lookups so the
 * unit tests run on inline fixtures:
 *
 * - C1 `paths`      backticked repository paths and file names exist
 * - C2 `scripts`    `bun run <name>` and bare `a:b` script names exist in the right `package.json`
 * - C3 `links`      relative Markdown link targets exist and `#fragments` name a heading
 * - C4 `facts`      pinned numbers in prose equal the constant in source; a dead pin is a violation
 * - C5 `config`     server loader keys ⇔ README table ⇔ `.env.example` ⇔ `dev-setup.ts`
 * - C6 `generated`  every generated block (README e2e table, verify skill gate table) equals what `generate-docs.ts` renders
 * - C7 `workspace`  Cargo and Bun workspace members ⇔ README Workspace Layout rows
 * - C8 `harness`    rules have matching `paths:`, skills are well-formed, AGENTS.md fits Codex's cap
 */

export type DocCheck =
  | 'paths'
  | 'scripts'
  | 'links'
  | 'facts'
  | 'config'
  | 'generated'
  | 'workspace'
  | 'harness'
  | 'layout';

export interface DocViolation {
  readonly file: string;
  readonly line: number;
  readonly check: DocCheck;
  readonly detail: string;
  readonly reason: string;
}

export interface ProseFile {
  readonly file: string;
  readonly source: string;
}

/** Path segments that never hold prose worth checking. */
export /** Vendored upstream trees carry their own READMEs; their links and paths are not ours. */
const VENDORED_PROSE = /^packages\/[^/]+-patch\//;

const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  'worktrees',
  'test-results',
  'work',
  'data',
]);

/** Codex reads the project instruction chain up to `project_doc_max_bytes` and truncates silently. */
export const AGENTS_MD_MAX_BYTES = 12_288;
export const AGENTS_CHAIN_MAX_BYTES = 32_768;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

function sortViolations(violations: DocViolation[]): DocViolation[] {
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.check.localeCompare(right.check) ||
      left.detail.localeCompare(right.detail),
  );
}

// ---------------------------------------------------------------------------------------
// Prose iteration

export interface ProseLine {
  readonly line: number;
  readonly text: string;
}

const FENCE = /^\s*(```|~~~)/;

/** Lines of a Markdown document outside fenced code blocks, 1-based. */
export function* proseLines(source: string): Generator<ProseLine> {
  let fence: string | undefined;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    const match = FENCE.exec(text);
    if (match?.[1] !== undefined) {
      if (fence === undefined) fence = match[1];
      else if (fence === match[1]) fence = undefined;
      continue;
    }
    if (fence === undefined) yield { line: index + 1, text };
  }
}

const INLINE_CODE = /`([^`\n]+)`/g;

function* inlineCode(text: string): Generator<string> {
  for (const match of text.matchAll(INLINE_CODE)) {
    if (match[1] !== undefined) yield match[1];
  }
}

// ---------------------------------------------------------------------------------------
// C1: paths

const ROOTED_PATH =
  /^(?:apps|packages|docs|scripts|tests|spikes|\.claude|\.agents|\.codex)\/[\w./@-]+$/;
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

export interface PathLookup {
  /** A repository-relative path exists. */
  readonly exists: (relative: string) => boolean;
}

/** Normalise a backticked token to a candidate path, or `undefined` when it is not one. */
export function pathCandidate(token: string): string | undefined {
  let candidate = token.trim();
  if (candidate.includes(' ') || candidate.includes('*') || candidate.includes('{')) {
    return undefined;
  }
  candidate = candidate.replace(LINE_SUFFIX, '').replace(/#.*$/, '').replace(/\/+$/, '');
  if (candidate.length === 0) return undefined;
  if (ROOTED_PATH.test(candidate)) return candidate;
  return undefined;
}

export function findPathViolations(
  file: string,
  source: string,
  lookup: PathLookup,
): DocViolation[] {
  const violations: DocViolation[] = [];
  const docDir = path.posix.dirname(file);
  for (const { line, text } of proseLines(source)) {
    for (const token of inlineCode(text)) {
      const candidate = pathCandidate(token);
      if (candidate === undefined) continue;
      // Rooted against the repository, or against the document's own directory (a skill
      // names its bundled `scripts/…` relative to itself). Bare file names are not checked:
      // prose legitimately names deleted files, build artifacts, and files in other repos.
      const found = lookup.exists(candidate) || lookup.exists(path.posix.join(docDir, candidate));
      if (!found) {
        violations.push({
          file,
          line,
          check: 'paths',
          detail: token,
          reason: 'path does not exist',
        });
      }
    }
  }
  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C2: scripts

const BUN_RUN = /^bun run (?:--cwd (\S+) )?([a-z][\w:-]*)(?:\s|$)/;
const CWD_ONLY = /^--cwd (\S+) ([a-z][\w:-]*)$/;
const BARE_SCRIPT = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/;

export interface ScriptLookup {
  /** Script names declared by `<dir>/package.json`; `undefined` when there is no such file. */
  readonly scriptsOf: (dir: string) => ReadonlySet<string> | undefined;
}

export function findScriptViolations(
  file: string,
  source: string,
  lookup: ScriptLookup,
): DocViolation[] {
  const violations: DocViolation[] = [];
  const rootScripts = lookup.scriptsOf('.') ?? new Set<string>();
  const prefixes = new Set<string>();
  for (const name of rootScripts) {
    const colon = name.indexOf(':');
    if (colon !== -1) prefixes.add(name.slice(0, colon));
  }

  const report = (line: number, token: string, dir: string, name: string): void => {
    const scripts = lookup.scriptsOf(dir);
    if (scripts === undefined) {
      violations.push({
        file,
        line,
        check: 'scripts',
        detail: token,
        reason: `${dir}/package.json does not exist`,
      });
    } else if (!scripts.has(name)) {
      violations.push({
        file,
        line,
        check: 'scripts',
        detail: token,
        reason: `script "${name}" is not declared in ${dir === '.' ? '' : `${dir}/`}package.json`,
      });
    }
  };

  for (const { line, text } of proseLines(source)) {
    for (const token of inlineCode(text)) {
      const trimmed = token.trim();
      if (trimmed.includes('*') || trimmed.includes('|')) continue;
      const run = BUN_RUN.exec(trimmed) ?? CWD_ONLY.exec(trimmed);
      if (run !== null && run[2] !== undefined) {
        if (run[2].includes('/') || run[2].includes('.')) continue;
        report(line, token, run[1] ?? '.', run[2]);
        continue;
      }
      if (BARE_SCRIPT.test(trimmed)) {
        const prefix = trimmed.slice(0, trimmed.indexOf(':'));
        if (prefixes.has(prefix)) report(line, token, '.', trimmed);
      }
    }
  }
  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C3: links

const MARKDOWN_LINK = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** GitHub-style heading slugs in document order, with `-n` suffixes for duplicates. */
export function headingSlugs(source: string): string[] {
  const seen = new Map<string, number>();
  const slugs: string[] = [];
  for (const { text } of proseLines(source)) {
    const heading = HEADING.exec(text);
    if (heading?.[2] === undefined) continue;
    const base = heading[2]
      .toLowerCase()
      .replace(/[`*_~[\]]/g, '')
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .trim()
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

export interface LinkLookup {
  readonly exists: (relative: string) => boolean;
  /** Source of a repository-relative Markdown file, or `undefined` when it cannot be read. */
  readonly readSource: (relative: string) => string | undefined;
}

export function findLinkViolations(
  file: string,
  source: string,
  lookup: LinkLookup,
): DocViolation[] {
  const violations: DocViolation[] = [];
  const docDir = path.posix.dirname(file);
  const ownSlugs = headingSlugs(source);
  for (const { line, text } of proseLines(source)) {
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const rawTarget = match[1];
      if (rawTarget === undefined || EXTERNAL_TARGET.test(rawTarget)) continue;
      const hash = rawTarget.indexOf('#');
      const targetPath = hash === -1 ? rawTarget : rawTarget.slice(0, hash);
      const fragment = hash === -1 ? undefined : rawTarget.slice(hash + 1);
      let slugs = ownSlugs;
      if (targetPath.length > 0) {
        const resolved = path.posix.normalize(
          path.posix.join(docDir, decodeURIComponent(targetPath)),
        );
        if (!lookup.exists(resolved)) {
          violations.push({
            file,
            line,
            check: 'links',
            detail: rawTarget,
            reason: `link target ${resolved} does not exist`,
          });
          continue;
        }
        if (fragment !== undefined) {
          const target = lookup.readSource(resolved);
          slugs = target === undefined ? [] : headingSlugs(target);
        }
      }
      if (fragment !== undefined && !slugs.includes(fragment.toLowerCase())) {
        violations.push({
          file,
          line,
          check: 'links',
          detail: rawTarget,
          reason: `no heading with slug "#${fragment}" in ${targetPath.length === 0 ? file : targetPath}`,
        });
      }
    }
  }
  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C4: pinned facts

export interface FactClaim {
  /** Matches one prose line; group 1 is the claimed value. */
  readonly pattern: RegExp;
  readonly normalize?: (raw: string) => string;
}

export interface PinnedFact {
  readonly name: string;
  readonly claims: readonly FactClaim[];
  readonly source: {
    readonly file: string;
    /** Matches the source; group 1 is the authoritative value. */
    readonly pattern: RegExp;
    readonly normalize?: (raw: string) => string;
  };
}

const WORD_NUMBERS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

export function wordToNumber(raw: string): string {
  return WORD_NUMBERS[raw.toLowerCase()] ?? raw;
}

const digits = (raw: string): string => raw.replace(/_/g, '');
const lowerHex = (raw: string): string => raw.toLowerCase();
const secondsToMs = (raw: string): string => String(Number(wordToNumber(raw)) * 1000);
const minutesToMs = (raw: string): string => String(Number(wordToNumber(raw)) * 60_000);

/**
 * Numbers prose asserts about the code. Each entry names the constant that owns the truth.
 *
 * Deliberately not pinned: dated history lines ("moved 10 to 22") in PERF.md and
 * `docs/performance.md`, which describe the past rather than the present.
 */
export const PINNED_FACTS: readonly PinnedFact[] = [
  {
    name: 'codec-version',
    claims: [
      { pattern: /`merkur_codec::VERSION` is the display wire version and is currently `(\d+)`/ },
      { pattern: /\bcodec version is (\d+)\b/ },
    ],
    source: {
      file: 'packages/merkur-codec/src/lib.rs',
      pattern: /^pub const VERSION: u8 = (\d+);/m,
    },
  },
  {
    name: 'loss-threshold',
    claims: [{ pattern: /`LOSS_PACKET_THRESHOLD` \((\w+)\)/, normalize: wordToNumber }],
    source: {
      file: 'apps/daemon/dataplane/src/display/policy.rs',
      pattern: /^pub const LOSS_PACKET_THRESHOLD: u32 = (\d+);/m,
    },
  },
  {
    name: 'dict-ready-type',
    claims: [
      { pattern: /`MSG_TYPE_DISPLAY_DICT_READY` \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
      { pattern: /\breadiness \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
    ],
    source: {
      file: 'packages/merkur-wire/src/protocol.rs',
      pattern: /^pub const MSG_TYPE_DISPLAY_DICT_READY: u8 = (0x[0-9a-fA-F]+);/m,
      normalize: lowerHex,
    },
  },
  {
    name: 'dict-install-type',
    claims: [
      { pattern: /`MSG_TYPE_DISPLAY_DICT_INSTALL` \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
      { pattern: /\bdaemon installs \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
    ],
    source: {
      file: 'packages/merkur-wire/src/protocol.rs',
      pattern: /^pub const MSG_TYPE_DISPLAY_DICT_INSTALL: u8 = (0x[0-9a-fA-F]+);/m,
      normalize: lowerHex,
    },
  },
  {
    name: 'dict-ack-type',
    claims: [
      { pattern: /`MSG_TYPE_DISPLAY_DICT_ACK` \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
      { pattern: /\backnowledges it \(`(0x[0-9a-fA-F]{2})`\)/, normalize: lowerHex },
    ],
    source: {
      file: 'packages/merkur-wire/src/protocol.rs',
      pattern: /^pub const MSG_TYPE_DISPLAY_DICT_ACK: u8 = (0x[0-9a-fA-F]+);/m,
      normalize: lowerHex,
    },
  },
  {
    name: 'zstd-level',
    claims: [{ pattern: /\bLevel (\d+) and (?:the|a) \d+ KiB dictionary cap/ }],
    source: {
      file: 'apps/daemon/dataplane/src/display/compressor.rs',
      pattern: /^pub const DISPLAY_COMPRESSION_LEVEL: i32 = (\d+);/m,
    },
  },
  {
    name: 'dict-cap-kib',
    claims: [{ pattern: /\bLevel \d+ and (?:the|a) (\d+) KiB dictionary cap/ }],
    source: {
      file: 'apps/daemon/dataplane/src/display/compressor.rs',
      pattern: /^pub const DISPLAY_DICTIONARY_MAX_BYTES: usize = (\d+) \* 1024;/m,
    },
  },
  {
    name: 'row-wrap-flag',
    claims: [{ pattern: /`ROW_FLAG_WRAPPED`(?:, | \()`?(0x[0-9a-fA-F]{4})/, normalize: lowerHex }],
    source: {
      file: 'packages/merkur-codec/src/lib.rs',
      pattern: /^pub const ROW_FLAG_WRAPPED: u16 = (0x[0-9a-fA-F]+);/m,
      normalize: lowerHex,
    },
  },
  {
    name: 'session-ttl-min-ms',
    claims: [
      { pattern: /must be from `(\d+)` through `\d+` ms/ },
      { pattern: /\bbounded from (\w+) seconds through \w+ minutes/, normalize: secondsToMs },
    ],
    source: {
      file: 'packages/config/src/server-config.ts',
      pattern: /^export const MIN_SESSION_TOKEN_TTL_MS = ([\d_]+);/m,
      normalize: digits,
    },
  },
  {
    name: 'session-ttl-max-ms',
    claims: [
      { pattern: /must be from `\d+` through `(\d+)` ms/ },
      { pattern: /\bbounded from \w+ seconds through (\w+) minutes/, normalize: minutesToMs },
    ],
    source: {
      file: 'packages/auth/src/session-authorization.ts',
      pattern: /^export const SESSION_AUTHORIZATION_MAX_LIFETIME_MS = ([\d_]+);/m,
      normalize: digits,
    },
  },
  {
    name: 'delegation-days',
    claims: [
      { pattern: /\bfixed[-, ](\d+)-day\b/ },
      { pattern: /\b(\d+)-day (?:ML-DSA-87 |browser |user-root )?delegation/ },
      { pattern: /\bnon-sliding (\d+)-day lifetime/ },
      { pattern: /\b(\d+)-day trust window/ },
    ],
    source: {
      file: 'packages/shared/src/user-authorization.ts',
      pattern: /^export const USER_DELEGATION_LIFETIME_MS = (\d+) \* 24 \* 60 \* 60 \* 1_000;/m,
    },
  },
];

export const FACT_REGISTRY_FILE = 'scripts/check-docs.ts';

export function findFactViolations(
  docs: readonly ProseFile[],
  readSource: (relative: string) => string | undefined,
  facts: readonly PinnedFact[] = PINNED_FACTS,
): DocViolation[] {
  const violations: DocViolation[] = [];
  for (const fact of facts) {
    const source = readSource(fact.source.file);
    const sourceMatch = source === undefined ? null : fact.source.pattern.exec(source);
    if (sourceMatch?.[1] === undefined) {
      violations.push({
        file: fact.source.file,
        line: 1,
        check: 'facts',
        detail: fact.name,
        reason: `pinned fact source pattern ${fact.source.pattern} matches nothing`,
      });
      continue;
    }
    const expected = (fact.source.normalize ?? ((raw) => raw))(sourceMatch[1]);
    let claimed = 0;
    for (const doc of docs) {
      for (const { line, text } of proseLines(doc.source)) {
        for (const claim of fact.claims) {
          const match = claim.pattern.exec(text);
          if (match?.[1] === undefined) continue;
          claimed += 1;
          const actual = (claim.normalize ?? ((raw) => raw))(match[1]);
          if (actual !== expected) {
            violations.push({
              file: doc.file,
              line,
              check: 'facts',
              detail: `${fact.name}: ${match[1]}`,
              reason: `${fact.source.file} says ${expected}`,
            });
          }
        }
      }
    }
    if (claimed === 0) {
      violations.push({
        file: FACT_REGISTRY_FILE,
        line: 1,
        check: 'facts',
        detail: fact.name,
        reason: 'pinned fact matches no prose claim; delete the entry or restore the claim',
      });
    }
  }
  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C5: config parity

export interface LoaderKey {
  readonly required: boolean;
  /** Literal default when the loader declares one and it can be resolved. */
  readonly defaultValue?: string;
}

export interface ConfigRow {
  readonly line: number;
  readonly key: string;
  readonly required: string;
  readonly notes: string;
}

function sectionLines(source: string, heading: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let inside = false;
  for (const entry of proseLines(source)) {
    if (/^##\s/.test(entry.text)) {
      inside = entry.text.trim() === heading;
      continue;
    }
    if (inside) lines.push(entry);
  }
  return lines;
}

const TABLE_ROW = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/;

/** Rows of the `## Configuration` table: key, Required cell, Notes cell. */
export function parseConfigTable(readme: string): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const { line, text } of sectionLines(readme, '## Configuration')) {
    const row = TABLE_ROW.exec(text);
    if (row?.[1] === undefined || row[2] === undefined || row[3] === undefined) continue;
    rows.push({ line, key: row[1], required: row[2], notes: row[3] });
  }
  return rows;
}

export interface EnvExampleEntry {
  readonly line: number;
  readonly commented: boolean;
}

const ENV_LINE = /^(#\s?)?([A-Z][A-Z0-9_]*)=/;

/** Keys `.env.example` lists, uncommented (`KEY=`) or as a commented placeholder (`# KEY=`). */
export function parseEnvExample(source: string): Map<string, EnvExampleEntry> {
  const entries = new Map<string, EnvExampleEntry>();
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = ENV_LINE.exec(lines[index] ?? '');
    if (match?.[2] === undefined) continue;
    const commented = match[1] !== undefined;
    const existing = entries.get(match[2]);
    if (existing === undefined || (existing.commented && !commented)) {
      entries.set(match[2], { line: index + 1, commented });
    }
  }
  return entries;
}

export interface ConfigParityInputs {
  readonly loaderKeys: ReadonlyMap<string, LoaderKey>;
  readonly readme: string;
  readonly envExample: string;
}

export const CONFIG_FILES = {
  readme: 'README.md',
  envExample: 'apps/server/.env.example',
  loader: 'packages/config/src/server-environment.ts',
} as const;

export function findConfigViolations(inputs: ConfigParityInputs): DocViolation[] {
  const violations: DocViolation[] = [];
  const rows = parseConfigTable(inputs.readme);
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const envEntries = parseEnvExample(inputs.envExample);

  for (const [key, loader] of inputs.loaderKeys) {
    const row = rowsByKey.get(key);
    if (row === undefined) {
      violations.push({
        file: CONFIG_FILES.readme,
        line: 1,
        check: 'config',
        detail: key,
        reason: 'loader key has no row in the ## Configuration table',
      });
    } else {
      const cell = row.required.trim();
      if (loader.required && /^no$/i.test(cell)) {
        violations.push({
          file: CONFIG_FILES.readme,
          line: row.line,
          check: 'config',
          detail: key,
          reason: 'the loader requires this key but the Required cell says No',
        });
      }
      if (!loader.required && /^yes$/i.test(cell)) {
        violations.push({
          file: CONFIG_FILES.readme,
          line: row.line,
          check: 'config',
          detail: key,
          reason: 'the loader defaults this key but the Required cell says Yes',
        });
      }
      if (loader.defaultValue !== undefined && !row.notes.includes(`\`${loader.defaultValue}\``)) {
        violations.push({
          file: CONFIG_FILES.readme,
          line: row.line,
          check: 'config',
          detail: key,
          reason: `Notes must quote the loader default \`${loader.defaultValue}\``,
        });
      }
    }

    const env = envEntries.get(key);
    if (env === undefined) {
      violations.push({
        file: CONFIG_FILES.envExample,
        line: 1,
        check: 'config',
        detail: key,
        reason: loader.required
          ? 'required loader key is not listed; add an uncommented `KEY=` line'
          : 'optional loader key is not listed; add a `# KEY=` placeholder',
      });
    } else if (loader.required && env.commented) {
      violations.push({
        file: CONFIG_FILES.envExample,
        line: env.line,
        check: 'config',
        detail: key,
        reason: 'required loader key must be an uncommented `KEY=` line',
      });
    }
  }

  for (const row of rows) {
    if (!inputs.loaderKeys.has(row.key)) {
      violations.push({
        file: CONFIG_FILES.readme,
        line: row.line,
        check: 'config',
        detail: row.key,
        reason: `row names a key ${CONFIG_FILES.loader} does not read`,
      });
    }
  }

  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C6: generated blocks

export type GeneratedBlockSite = Pick<GeneratedBlock, 'file' | 'name' | 'label'>;

/** The text between a block's markers in `source` must equal what the generator renders. */
export function findGeneratedBlockViolations(
  source: string,
  block: GeneratedBlockSite,
  rendered: string,
): DocViolation[] {
  const { open, close } = generatedMarkers(block.name);
  const start = source.indexOf(open);
  const end = start === -1 ? -1 : source.indexOf(close, start + open.length);
  if (start === -1 || end === -1) {
    return [
      {
        file: block.file,
        line: 1,
        check: 'generated',
        detail: block.name,
        reason: `markers absent: wrap the ${block.label} in ${open} … ${close} and run \`bun run generate:docs\``,
      },
    ];
  }
  const current = source.slice(start + open.length, end).replace(/^\n/, '');
  const expected = rendered.endsWith('\n') ? rendered : `${rendered}\n`;
  if (current === expected) return [];
  const line = source.slice(0, start).split('\n').length;
  return [
    {
      file: block.file,
      line,
      check: 'generated',
      detail: block.name,
      reason: `${block.label} is stale: run \`bun run generate:docs\``,
    },
  ];
}

// ---------------------------------------------------------------------------------------
// C7: workspace parity

function tomlList(source: string, key: string): string[] {
  const match = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(source);
  if (match?.[1] === undefined) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].flatMap((entry) =>
    entry[1] === undefined ? [] : [entry[1]],
  );
}

/** Cargo members, excluded crates, and `[patch.crates-io]` path targets. */
export function cargoWorkspacePaths(cargoToml: string): string[] {
  const paths = new Set<string>([
    ...tomlList(cargoToml, 'members'),
    ...tomlList(cargoToml, 'exclude'),
  ]);
  const patchStart = cargoToml.indexOf('[patch.crates-io]');
  if (patchStart !== -1) {
    const section = cargoToml.slice(patchStart);
    const sectionEnd = section.indexOf('\n[', 1);
    for (const match of section
      .slice(0, sectionEnd === -1 ? section.length : sectionEnd)
      .matchAll(/path\s*=\s*"([^"]+)"/g)) {
      if (match[1] !== undefined) paths.add(match[1]);
    }
  }
  return [...paths].sort();
}

export interface WorkspaceInputs {
  readonly cargoToml: string;
  /** Directories matched by the root `package.json` workspace globs that hold a `package.json`. */
  readonly bunWorkspaces: readonly string[];
  readonly readme: string;
  readonly exists: (relative: string) => boolean;
}

/** Rows of the `## Workspace Layout` table, by path. */
export function parseWorkspaceTable(readme: string): Map<string, number> {
  const rows = new Map<string, number>();
  for (const { line, text } of sectionLines(readme, '## Workspace Layout')) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(text);
    if (row?.[1] !== undefined) rows.set(row[1].replace(/\/$/, ''), line);
  }
  return rows;
}

export function findWorkspaceViolations(inputs: WorkspaceInputs): DocViolation[] {
  const violations: DocViolation[] = [];
  const expected = new Set([...cargoWorkspacePaths(inputs.cargoToml), ...inputs.bunWorkspaces]);
  const rows = parseWorkspaceTable(inputs.readme);
  for (const dir of expected) {
    if (!rows.has(dir)) {
      violations.push({
        file: CONFIG_FILES.readme,
        line: 1,
        check: 'workspace',
        detail: dir,
        reason: 'workspace member has no row in the ## Workspace Layout table',
      });
    }
  }
  for (const [dir, line] of rows) {
    if (!inputs.exists(dir)) {
      violations.push({
        file: CONFIG_FILES.readme,
        line,
        check: 'workspace',
        detail: dir,
        reason: 'Workspace Layout row names a path that does not exist',
      });
    }
  }
  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// C8: harness shape

export interface RuleFile {
  readonly file: string;
  readonly source: string;
}

export interface SkillFile {
  readonly file: string;
  readonly dir: string;
  readonly source: string;
}

export interface AgentsFile {
  readonly file: string;
  readonly bytes: number;
}

export interface HarnessInputs {
  readonly rules: readonly RuleFile[];
  readonly skills: readonly SkillFile[];
  /** Every `AGENTS.md`, repository-relative, with its byte size. */
  readonly agents: readonly AgentsFile[];
  readonly claudeMd: string | undefined;
  /** Number of repository files a rule glob matches. */
  readonly globMatches: (glob: string) => number;
}

function frontmatter(source: string): string | undefined {
  if (!source.startsWith('---')) return undefined;
  const end = source.indexOf('\n---', 3);
  return end === -1 ? undefined : source.slice(3, end);
}

function frontmatterField(block: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block);
  return match?.[1]?.trim();
}

/** Globs declared under `paths:` — inline `["a", "b"]`, `a, b`, or a YAML list. */
export function rulePaths(source: string): string[] | undefined {
  const block = frontmatter(source);
  if (block === undefined) return undefined;
  const inline = frontmatterField(block, 'paths');
  if (inline === undefined) return undefined;
  if (inline.length > 0) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter((entry) => entry.length > 0);
  }
  const globs: string[] = [];
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^paths:/.test(line));
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item?.[1] === undefined) break;
    globs.push(item[1].replace(/^["']|["']$/g, ''));
  }
  return globs;
}

export function findHarnessViolations(inputs: HarnessInputs): DocViolation[] {
  const violations: DocViolation[] = [];

  for (const rule of inputs.rules) {
    const globs = rulePaths(rule.source);
    if (globs === undefined || globs.length === 0) {
      violations.push({
        file: rule.file,
        line: 1,
        check: 'harness',
        detail: 'paths',
        reason: 'rule has no `paths:` frontmatter, so it would load for every file',
      });
      continue;
    }
    for (const glob of globs) {
      if (inputs.globMatches(glob) === 0) {
        violations.push({
          file: rule.file,
          line: 1,
          check: 'harness',
          detail: glob,
          reason: 'rule glob matches no file in the repository',
        });
      }
    }
  }

  for (const skill of inputs.skills) {
    const block = frontmatter(skill.source);
    const name = block === undefined ? undefined : frontmatterField(block, 'name');
    const description = block === undefined ? undefined : frontmatterField(block, 'description');
    if (name !== skill.dir) {
      violations.push({
        file: skill.file,
        line: 1,
        check: 'harness',
        detail: `name: ${name ?? '(missing)'}`,
        reason: `skill name must equal its directory "${skill.dir}"`,
      });
    }
    if (description === undefined || description.length === 0) {
      violations.push({
        file: skill.file,
        line: 1,
        check: 'harness',
        detail: 'description',
        reason: 'skill has no description; nothing would ever load it',
      });
    } else if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
      violations.push({
        file: skill.file,
        line: 1,
        check: 'harness',
        detail: `description: ${description.length} chars`,
        reason: `skill description exceeds ${SKILL_DESCRIPTION_MAX_CHARS} characters`,
      });
    }
  }

  const sizes = new Map(inputs.agents.map((entry) => [entry.file, entry.bytes]));
  const rootBytes = sizes.get('AGENTS.md');
  if (rootBytes !== undefined && rootBytes > AGENTS_MD_MAX_BYTES) {
    violations.push({
      file: 'AGENTS.md',
      line: 1,
      check: 'harness',
      detail: `${rootBytes} B`,
      reason: `AGENTS.md exceeds ${AGENTS_MD_MAX_BYTES} B; Codex truncates the chain at ${AGENTS_CHAIN_MAX_BYTES} B and the room is reserved for nested files and rules`,
    });
  }
  for (const entry of inputs.agents) {
    if (entry.file === 'AGENTS.md') continue;
    let chain = entry.bytes;
    let dir = path.posix.dirname(entry.file);
    while (dir !== '.' && dir !== '/') {
      dir = path.posix.dirname(dir);
      chain += sizes.get(dir === '.' ? 'AGENTS.md' : `${dir}/AGENTS.md`) ?? 0;
    }
    if (chain > AGENTS_CHAIN_MAX_BYTES) {
      violations.push({
        file: entry.file,
        line: 1,
        check: 'harness',
        detail: `${chain} B`,
        reason: `AGENTS.md ancestor chain exceeds ${AGENTS_CHAIN_MAX_BYTES} B; Codex truncates it silently`,
      });
    }
  }

  if (inputs.claudeMd !== undefined) {
    const first = inputs.claudeMd
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (first !== '@AGENTS.md') {
      violations.push({
        file: 'CLAUDE.md',
        line: 1,
        check: 'harness',
        detail: first ?? '(empty)',
        reason: 'CLAUDE.md must begin with `@AGENTS.md` so both tools read one instruction source',
      });
    }
  }

  return sortViolations(violations);
}

// ---------------------------------------------------------------------------------------
// Repository scan

// ---------------------------------------------------------------------------------------
// C8: layout
//
// `docs/` is reference: present tense, undated, no results. Dated records, unbuilt designs
// and open items live in the private `merkur-private-docs` repository, whose own gate
// enforces their shape, and public prose never mentions or links them. A date inside inline
// code (a command, a literal) is not prose.

const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const DATE_G = /\b\d{4}-\d{2}-\d{2}\b/g;

export function findLayoutViolations(docs: readonly ProseFile[]): DocViolation[] {
  const violations: DocViolation[] = [];
  for (const { file, source } of docs) {
    if (!file.startsWith('docs/')) continue;
    if (DATE.test(path.posix.basename(file))) {
      violations.push({
        file,
        line: 1,
        check: 'layout',
        detail: path.posix.basename(file),
        reason: 'a dated file is a record, not reference; it belongs in merkur-private-docs',
      });
    }
    for (const { line, text } of proseLines(source)) {
      const bare = text.replace(INLINE_CODE, '');
      for (const match of bare.matchAll(DATE_G)) {
        violations.push({
          file,
          line,
          check: 'layout',
          detail: match[0],
          reason:
            'reference prose is undated; drop the date and record the event in merkur-private-docs',
        });
      }
    }
  }
  return sortViolations(violations);
}

/**
 * Every file in the checkout outside the excluded segments, repository-relative and sorted.
 *
 * A hand-rolled walk rather than `Bun.Glob`: a glob visits `node_modules` and `target` in
 * full before a filter can see the path, which cost this gate fifty seconds. Pruning at the
 * directory level makes it a hundred milliseconds. Symlinked directories are followed once
 * by real path, so `.agents/skills -> ../.claude/skills` yields one copy of each skill.
 */
export function walkRepository(root: string = ROOT): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isSymbolicLink()) {
        let target: Stats;
        try {
          target = statSync(path.join(root, child));
        } catch {
          continue;
        }
        if (target.isDirectory()) visit(child);
        else files.push(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit('');
  return files.sort();
}

export function listProseFiles(
  root: string = ROOT,
  files: readonly string[] = walkRepository(root),
): string[] {
  const seen = new Set<string>();
  const prose: string[] = [];
  for (const relative of files) {
    if (!relative.endsWith('.md')) continue;
    if (VENDORED_PROSE.test(relative)) continue;
    let real: string;
    try {
      real = realpathSync(path.join(root, relative));
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    // Name the file by its real location, so a symlink alias such as `.agents/skills`
    // reports as `.claude/skills` whichever the walk met first.
    const inside = real.startsWith(`${root}${path.sep}`);
    prose.push(inside ? path.relative(root, real).split(path.sep).join('/') : relative);
  }
  return prose.sort();
}

function readOptional(root: string, relative: string): string | undefined {
  try {
    return readFileSync(path.join(root, relative), 'utf8');
  } catch {
    return undefined;
  }
}

function scriptsOfPackage(root: string, dir: string): ReadonlySet<string> | undefined {
  const text = readOptional(root, path.posix.join(dir, 'package.json'));
  if (text === undefined) return undefined;
  const parsed: unknown = JSON.parse(text);
  const scripts =
    typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : {};
  return new Set(typeof scripts === 'object' && scripts !== null ? Object.keys(scripts) : []);
}

function bunWorkspaceDirs(root: string): string[] {
  const text = readOptional(root, 'package.json') ?? '{}';
  const parsed: unknown = JSON.parse(text);
  const workspaces =
    typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed
      ? parsed.workspaces
      : undefined;
  const globs =
    typeof workspaces === 'object' && workspaces !== null && 'packages' in workspaces
      ? workspaces.packages
      : workspaces;
  if (!Array.isArray(globs)) return [];
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (typeof glob !== 'string') continue;
    for (const match of new Glob(`${glob}/package.json`).scanSync({ cwd: root })) {
      dirs.add(path.posix.dirname(match));
    }
  }
  return [...dirs].sort();
}

function globMatchCount(files: readonly string[], glob: string): number {
  const matcher = new Glob(glob);
  let count = 0;
  for (const relative of files) {
    if (matcher.match(relative)) count += 1;
  }
  return count;
}

export function scanDocs(root: string = ROOT): DocViolation[] {
  return scanDocsWithIgnoreLookup(
    root,
    (relative) =>
      Bun.spawnSync(['git', 'check-ignore', '--quiet', relative], { cwd: root }).exitCode === 0,
  );
}

/** The engine supplies Git ignore decisions over its declared tree and captured index. */
export function scanDocsWithIgnoreLookup(
  root: string,
  ignored: (relative: string) => boolean,
): DocViolation[] {
  const violations: DocViolation[] = [];
  const files = walkRepository(root);
  const docs: ProseFile[] = listProseFiles(root, files).map((file) => ({
    file,
    source: readFileSync(path.join(root, file), 'utf8'),
  }));

  const exists = (relative: string): boolean => existsSync(path.join(root, relative));
  // A path the repository deliberately leaves untracked (the `.env` setup writes, a build
  // output) is absent from a fresh clone by design, and git's own ignore rules say which.
  const existsOrIgnored = (relative: string): boolean => exists(relative) || ignored(relative);
  const scriptCache = new Map<string, ReadonlySet<string> | undefined>();
  const scriptsOf = (dir: string): ReadonlySet<string> | undefined => {
    if (!scriptCache.has(dir)) scriptCache.set(dir, scriptsOfPackage(root, dir));
    return scriptCache.get(dir);
  };
  const readSource = (relative: string): string | undefined => readOptional(root, relative);

  for (const doc of docs) {
    violations.push(
      ...findPathViolations(doc.file, doc.source, { exists: existsOrIgnored }),
      ...findScriptViolations(doc.file, doc.source, { scriptsOf }),
      ...findLinkViolations(doc.file, doc.source, { exists, readSource }),
    );
  }

  violations.push(...findFactViolations(docs, readSource));
  violations.push(...findLayoutViolations(docs));

  const loaderKeys = currentServerEnvironmentKeys();
  const readme = readOptional(root, CONFIG_FILES.readme) ?? '';
  violations.push(
    ...findConfigViolations({
      loaderKeys,
      readme,
      envExample: readOptional(root, CONFIG_FILES.envExample) ?? '',
    }),
  );

  for (const block of GENERATED_BLOCKS) {
    violations.push(
      ...findGeneratedBlockViolations(
        readOptional(root, block.file) ?? '',
        block,
        block.render(root),
      ),
    );
  }

  violations.push(
    ...findWorkspaceViolations({
      cargoToml: readOptional(root, 'Cargo.toml') ?? '',
      bunWorkspaces: bunWorkspaceDirs(root),
      readme,
      exists,
    }),
  );

  const rules: RuleFile[] = [];
  for (const relative of new Glob('.claude/rules/*.md').scanSync({ cwd: root, dot: true })) {
    rules.push({ file: relative, source: readFileSync(path.join(root, relative), 'utf8') });
  }
  const skills: SkillFile[] = [];
  for (const relative of new Glob('.claude/skills/*/SKILL.md').scanSync({ cwd: root, dot: true })) {
    skills.push({
      file: relative,
      dir: path.posix.basename(path.posix.dirname(relative)),
      source: readFileSync(path.join(root, relative), 'utf8'),
    });
  }
  const agents: AgentsFile[] = docs
    .filter((doc) => path.posix.basename(doc.file) === 'AGENTS.md')
    .map((doc) => ({ file: doc.file, bytes: statSync(path.join(root, doc.file)).size }));
  violations.push(
    ...findHarnessViolations({
      rules: rules.sort((left, right) => left.file.localeCompare(right.file)),
      skills: skills.sort((left, right) => left.file.localeCompare(right.file)),
      agents,
      claudeMd: readOptional(root, 'CLAUDE.md'),
      globMatches: (glob) => globMatchCount(files, glob),
    }),
  );

  return sortViolations(violations);
}

if (import.meta.main) {
  const violations = scanDocs();
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `${violation.file}:${violation.line} [${violation.check}] ${violation.detail} — ${violation.reason}\n`,
      );
    }
    process.stderr.write(`\n${violations.length} documentation violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write(
    `check:docs: pass (${listProseFiles().length} prose files, ${PINNED_FACTS.length} pinned facts)\n`,
  );
}
