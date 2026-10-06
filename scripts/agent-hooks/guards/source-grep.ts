import path from 'node:path';

import type { GuardContext, GuardDecision } from '../hook-io';
import { hasGlob, type SimpleCommand } from '../shell-command';

/**
 * The CodeGraph rule, mechanised.
 *
 * AGENTS.md says: never grep, find, cat or sed your way through source in this repo — the
 * index already holds the answer. Prose keeps that rule most of the time; this guard keeps
 * it all of the time, for the shell tools below and for Claude's built-in `Grep` tool
 * (which Explore/Plan subagents reach for because they never see AGENTS.md).
 *
 * The line it draws: a *source-scoped* operand is one under `apps/`, `packages/`,
 * `scripts/`, `tests/` or `spikes/` (or the repository root itself) that is a directory, a
 * glob, or a file with a source extension. Everything else — prose, config, env files,
 * logs, lockfiles, build output — is what grep is *for*, and stays allowed. A restrictor
 * (`--include='*.md'`, `-g '*.md'`, `--type md`, `-name '*.md'`) that admits only allowed
 * extensions neutralises a source-scoped directory, because the sweep then touches no
 * source.
 *
 * Denied whether or not the index exists. Without it the reason says how to build it
 * (`codegraph init .`, about a second); grep over source is never the alternative.
 */

const SOURCE_ROOTS: ReadonlySet<string> = new Set([
  'apps',
  'packages',
  'scripts',
  'tests',
  'spikes',
]);
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'wgsl',
]);
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'mdx',
  'txt',
  'toml',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'lock',
  'log',
  'env',
  'service',
  'sh',
  'sql',
  'csv',
  'html',
  'css',
  'example',
  'pem',
]);
/** Extensionless or dot-named prose and config that lives under the source roots. */
const ALLOWED_BASENAME =
  /^(?:Dockerfile.*|fly\.toml|\.env.*|(?:LICENSE|NOTICE|COPYING)(?:-[A-Z0-9-]+)?|\.gitignore|\.dockerignore|\.gitattributes)$/;
const ALLOWED_DIRECTORIES: ReadonlySet<string> = new Set([
  'docs',
  'target',
  'dist',
  'node_modules',
  '.codegraph',
  'test-results',
  'data',
]);
/** ripgrep/ack/fd type names that resolve to non-source files. */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'toml',
  'json',
  'yaml',
  'yml',
  'lock',
  'log',
  'sh',
  'sql',
  'csv',
  'html',
  'css',
  'config',
  'env',
  'readme',
  'license',
  'pem',
  'service',
]);

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'ugrep',
  'find',
  'fd',
  'fdfind',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'sed',
  'gsed',
  'awk',
  'gawk',
  'mawk',
  'nawk',
]);

type OperandClass = 'source' | 'allowed' | 'outside';

function extensionOf(name: string): string | null {
  const braced = /\.\{([^}]+)\}\$?$/.exec(name);
  if (braced !== null) return braced[1] ?? null;
  const match = /\\?\.([A-Za-z0-9]+)\$?$/.exec(name);
  if (match === null) return null;
  if (name.startsWith('.') && name.indexOf('.', 1) === -1) return null;
  return match[1] ?? null;
}

function extensionsAllowed(ext: string): boolean {
  return ext.split(',').every((item) => ALLOWED_EXTENSIONS.has(item.trim().toLowerCase()));
}

function extensionsSource(ext: string): boolean {
  return ext.split(',').some((item) => SOURCE_EXTENSIONS.has(item.trim().toLowerCase()));
}

/** Classify one path operand relative to the repository root. */
export function classifyOperand(operand: string, cwd: string, root: string): OperandClass {
  if (operand.startsWith('~')) return 'outside';
  const absolute = path.resolve(cwd, operand);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'outside';
  const segments = relative.split(path.sep).filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => ALLOWED_DIRECTORIES.has(segment))) return 'allowed';

  const last = segments[segments.length - 1] ?? '';
  if (ALLOWED_BASENAME.test(last)) return 'allowed';

  const first = segments[0] ?? '';
  const underSourceRoot = segments.length === 0 || SOURCE_ROOTS.has(first) || hasGlob(first);
  const ext = extensionOf(last);
  if (ext !== null) {
    if (extensionsAllowed(ext)) return 'allowed';
    if (!extensionsSource(ext)) return 'outside';
    return underSourceRoot ? 'source' : 'outside';
  }
  return underSourceRoot ? 'source' : 'outside';
}

/**
 * Does a restrictor glob admit only allowed files? A negated glob restricts nothing; a glob
 * with no extension admits whatever lives under its directory.
 */
export function restrictorAdmitsOnlyAllowed(glob: string, cwd: string, root: string): boolean {
  if (glob.startsWith('!')) return false;
  const ext = extensionOf(glob);
  if (ext !== null) return extensionsAllowed(ext);
  return classifyOperand(glob, cwd, root) === 'allowed';
}

export function typeAdmitsOnlyAllowed(typeName: string): boolean {
  return ALLOWED_TYPES.has(typeName.toLowerCase());
}

export interface GrepProbe {
  readonly tool: string;
  readonly paths: readonly string[];
  readonly restrictors: readonly string[];
  readonly types: readonly string[];
  readonly cwd: string;
}

interface ToolSpec {
  /** Flags (short or long) that consume the next word. */
  readonly withArg: ReadonlySet<string>;
  /** Flags whose argument is a file glob. */
  readonly restrictors: ReadonlySet<string>;
  /** Flags whose argument is a type name. */
  readonly types: ReadonlySet<string>;
  /** Flags that supply the pattern, so the first positional is a path. */
  readonly patternFlags: ReadonlySet<string>;
  /** The first positional is a pattern (grep) rather than a path (cat). */
  readonly firstPositionalIsPattern: boolean;
  /** Flags that turn a path-less invocation into a sweep of `.`. */
  readonly recursiveFlags: ReadonlySet<string>;
  /** The tool always sweeps `.` when given no path. */
  readonly alwaysRecursive: boolean;
  /** Flags after which every remaining word belongs to a sub-command. */
  readonly terminalFlags: ReadonlySet<string>;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);
const NONE: ReadonlySet<string> = new Set();

const GREP_SPEC: ToolSpec = {
  withArg: set(
    '-e',
    '-f',
    '-m',
    '-A',
    '-B',
    '-C',
    '-d',
    '-D',
    '--regexp',
    '--file',
    '--max-count',
    '--after-context',
    '--before-context',
    '--context',
    '--include',
    '--exclude',
    '--exclude-dir',
    '--exclude-from',
    '--label',
    '--devices',
    '--directories',
    '--binary-files',
  ),
  restrictors: set('--include'),
  types: NONE,
  patternFlags: set('-e', '-f', '--regexp', '--file'),
  firstPositionalIsPattern: true,
  recursiveFlags: set('-r', '-R', '--recursive', '--dereference-recursive'),
  alwaysRecursive: false,
  terminalFlags: NONE,
};

const RG_SPEC: ToolSpec = {
  withArg: set(
    '-e',
    '-f',
    '-g',
    '-t',
    '-T',
    '-m',
    '-A',
    '-B',
    '-C',
    '-M',
    '-j',
    '-r',
    '-E',
    '--regexp',
    '--file',
    '--glob',
    '--iglob',
    '--type',
    '--type-not',
    '--type-add',
    '--max-count',
    '--after-context',
    '--before-context',
    '--context',
    '--max-columns',
    '--threads',
    '--replace',
    '--encoding',
    '--max-depth',
    '--maxdepth',
    '--color',
    '--colors',
    '--sort',
    '--sortr',
    '--context-separator',
    '--field-context-separator',
    '--field-match-separator',
    '--path-separator',
    '--pre',
    '--pre-glob',
    '--engine',
    '--ignore-file',
    '--dfa-size-limit',
    '--regex-size-limit',
    '--max-filesize',
    '--hostname-bin',
  ),
  restrictors: set('-g', '--glob', '--iglob'),
  types: set('-t', '--type'),
  patternFlags: set('-e', '-f', '--regexp', '--file', '--files', '--type-list'),
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: true,
  terminalFlags: NONE,
};

const AG_SPEC: ToolSpec = {
  withArg: set(
    '-A',
    '-B',
    '-C',
    '-G',
    '-g',
    '-m',
    '-p',
    '--after',
    '--before',
    '--context',
    '--file-search-regex',
    '--ignore',
    '--ignore-dir',
    '--pager',
    '--depth',
    '--path-to-ignore',
  ),
  restrictors: set('-G', '--file-search-regex'),
  types: NONE,
  patternFlags: NONE,
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: true,
  terminalFlags: NONE,
};

const ACK_SPEC: ToolSpec = {
  withArg: set(
    '-A',
    '-B',
    '-C',
    '-m',
    '-g',
    '-x',
    '-G',
    '--type',
    '--ignore-dir',
    '--ignore-file',
    '--after-context',
    '--before-context',
    '--context',
    '--max-count',
    '--match',
    '--pager',
    '--type-set',
    '--type-add',
  ),
  restrictors: NONE,
  types: set('--type'),
  patternFlags: set('--match'),
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: true,
  terminalFlags: NONE,
};

const GIT_GREP_SPEC: ToolSpec = {
  withArg: set(
    '-e',
    '-f',
    '-A',
    '-B',
    '-C',
    '-m',
    '-O',
    '--max-depth',
    '--open-files-in-pager',
    '--threads',
    '--max-count',
  ),
  restrictors: NONE,
  types: NONE,
  patternFlags: set('-e', '-f'),
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: true,
  terminalFlags: NONE,
};

const FD_SPEC: ToolSpec = {
  withArg: set(
    '-e',
    '--extension',
    '-t',
    '--type',
    '-E',
    '--exclude',
    '-d',
    '--max-depth',
    '--maxdepth',
    '--min-depth',
    '--exact-depth',
    '-S',
    '--size',
    '--changed-within',
    '--changed-before',
    '--changed-after',
    '-o',
    '--owner',
    '-j',
    '--threads',
    '-c',
    '--color',
    '--base-directory',
    '--search-path',
    '--path-separator',
    '--ignore-file',
    '--max-results',
    '--and',
    '--batch-size',
    '--max-buffer-time',
  ),
  restrictors: NONE,
  types: set('-e', '--extension'),
  patternFlags: NONE,
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: true,
  terminalFlags: set('-x', '--exec', '-X', '--exec-batch'),
};

const READER_SPEC: ToolSpec = {
  withArg: set(
    '-n',
    '-c',
    '--lines',
    '--bytes',
    '-s',
    '--sleep-interval',
    '--pid',
    '-l',
    '--language',
    '--style',
    '--theme',
    '-r',
    '--line-range',
    '-m',
    '--map-syntax',
    '--paging',
    '--color',
    '--decorations',
    '--italic-text',
    '--tabs',
    '--wrap',
    '--terminal-width',
    '-H',
    '--highlight-line',
    '--file-name',
    '--diff-context',
    '-p',
    '-j',
    '-x',
    '-o',
    '-O',
    '-b',
    '-#',
    '--pattern',
    '-T',
    '-k',
  ),
  restrictors: NONE,
  types: NONE,
  patternFlags: NONE,
  firstPositionalIsPattern: false,
  recursiveFlags: NONE,
  alwaysRecursive: false,
  terminalFlags: NONE,
};

const SED_SPEC: ToolSpec = {
  withArg: set('-e', '-f', '-l', '--expression', '--file', '--line-length'),
  restrictors: NONE,
  types: NONE,
  patternFlags: set('-e', '-f', '--expression', '--file'),
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: false,
  terminalFlags: NONE,
};

const AWK_SPEC: ToolSpec = {
  withArg: set('-f', '-F', '-v', '--file', '--field-separator', '--assign'),
  restrictors: NONE,
  types: NONE,
  patternFlags: set('-f', '--file'),
  firstPositionalIsPattern: true,
  recursiveFlags: NONE,
  alwaysRecursive: false,
  terminalFlags: NONE,
};

const SPECS: Readonly<Record<string, ToolSpec>> = {
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  ugrep: GREP_SPEC,
  rg: RG_SPEC,
  ag: AG_SPEC,
  ack: ACK_SPEC,
  fd: FD_SPEC,
  fdfind: FD_SPEC,
  cat: READER_SPEC,
  head: READER_SPEC,
  tail: READER_SPEC,
  less: READER_SPEC,
  more: READER_SPEC,
  bat: READER_SPEC,
  sed: SED_SPEC,
  gsed: SED_SPEC,
  awk: AWK_SPEC,
  gawk: AWK_SPEC,
  mawk: AWK_SPEC,
  nawk: AWK_SPEC,
};

interface ParsedArgs {
  readonly paths: string[];
  readonly restrictors: string[];
  readonly types: string[];
  readonly recursive: boolean;
}

function parseWithSpec(args: readonly string[], spec: ToolSpec, tool: string): ParsedArgs {
  const paths: string[] = [];
  const restrictors: string[] = [];
  const types: string[] = [];
  let recursive = spec.alwaysRecursive;
  let patternSeen = !spec.firstPositionalIsPattern;
  let afterDoubleDash = false;

  const record = (flag: string, value: string): void => {
    if (spec.restrictors.has(flag)) restrictors.push(value);
    if (spec.types.has(flag)) types.push(value);
    if (spec.patternFlags.has(flag)) patternSeen = true;
  };

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? '';
    if (afterDoubleDash || !word.startsWith('-') || word === '-') {
      if (!afterDoubleDash && word.startsWith('+') && (tool === 'less' || tool === 'more'))
        continue;
      if (patternSeen) {
        paths.push(word);
      } else {
        patternSeen = true;
      }
      continue;
    }
    if (word === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (spec.terminalFlags.has(word)) break;
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const flag = equals === -1 ? word : word.slice(0, equals);
      if (spec.recursiveFlags.has(flag)) recursive = true;
      if (spec.patternFlags.has(flag) && !spec.withArg.has(flag)) patternSeen = true;
      if (equals !== -1) {
        record(flag, word.slice(equals + 1));
      } else if (spec.withArg.has(flag)) {
        record(flag, args[index + 1] ?? '');
        index += 1;
      } else if (tool === 'ack' && typeAdmitsOnlyAllowed(flag.slice(2))) {
        types.push(flag.slice(2));
      }
      continue;
    }
    // Short cluster: `-rn`, `-A3`, `-e pattern`.
    if (/^-\d+$/.test(word)) continue;
    for (let offset = 1; offset < word.length; offset += 1) {
      const flag = `-${word[offset] ?? ''}`;
      if (spec.recursiveFlags.has(flag)) recursive = true;
      if (tool === 'sed' && flag === '-i') {
        // BSD `sed -i ''` takes an (empty) suffix operand; GNU `-i` takes none.
        if (offset === word.length - 1 && args[index + 1] === '') index += 1;
        continue;
      }
      if (spec.withArg.has(flag)) {
        const attached = word.slice(offset + 1);
        if (attached !== '') {
          record(flag, attached);
        } else {
          record(flag, args[index + 1] ?? '');
          index += 1;
        }
        break;
      }
    }
  }
  return { paths, restrictors, types, recursive };
}

function parseFind(args: readonly string[]): ParsedArgs {
  const paths: string[] = [];
  const restrictors: string[] = [];
  let index = 0;
  while (index < args.length) {
    const word = args[index] ?? '';
    if (word === '-f') {
      paths.push(args[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (/^-[HLPEsxd]+$/.test(word)) {
      index += 1;
      continue;
    }
    break;
  }
  while (index < args.length) {
    const word = args[index] ?? '';
    if (word.startsWith('-') || word === '!' || word === '(' || word === '\\(') break;
    paths.push(word);
    index += 1;
  }
  for (; index < args.length; index += 1) {
    const word = args[index] ?? '';
    if (
      word === '-name' ||
      word === '-iname' ||
      word === '-path' ||
      word === '-ipath' ||
      word === '-wholename' ||
      word === '-iwholename'
    ) {
      restrictors.push(args[index + 1] ?? '');
      index += 1;
    }
  }
  return { paths, restrictors, types: [], recursive: true };
}

/** Locate `grep` inside `git [-C dir] [--no-pager] grep …`; returns the adjusted cwd too. */
function parseGitGrep(
  argv: readonly string[],
  cwd: string,
): { readonly parsed: ParsedArgs; readonly cwd: string } | null {
  let index = 1;
  let effectiveCwd = cwd;
  while (index < argv.length) {
    const word = argv[index] ?? '';
    if (word === 'grep') break;
    if (word === '-C') {
      effectiveCwd = path.resolve(effectiveCwd, argv[index + 1] ?? '.');
      index += 2;
      continue;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    return null;
  }
  if (argv[index] !== 'grep') return null;
  return { parsed: parseWithSpec(argv.slice(index + 1), GIT_GREP_SPEC, 'git'), cwd: effectiveCwd };
}

/** Reduce a shell command to a probe, or `null` when it is not a search/read tool. */
export function probeFromCommand(command: SimpleCommand): GrepProbe | null {
  const tool = path.basename(command.argv[0] ?? '');
  const args = command.argv.slice(1);
  let parsed: ParsedArgs;
  let cwd = command.cwd;
  if (tool === 'git') {
    const git = parseGitGrep(command.argv, command.cwd);
    if (git === null) return null;
    parsed = git.parsed;
    cwd = git.cwd;
  } else if (tool === 'find') {
    parsed = parseFind(args);
  } else if (SHELL_TOOLS.has(tool)) {
    const spec = SPECS[tool];
    if (spec === undefined) return null;
    parsed = parseWithSpec(args, spec, tool);
  } else {
    return null;
  }

  let paths = parsed.paths.filter((operand) => operand !== '');
  if (paths.length === 0) {
    // No operand: a recursive tool sweeps `.`; a filter reads stdin.
    if (!parsed.recursive) return null;
    if (command.pipedFromPrevious) return null;
    paths = ['.'];
  }
  return {
    tool: tool === 'git' ? 'git grep' : tool,
    paths,
    restrictors: parsed.restrictors.filter((item) => item !== ''),
    types: parsed.types.filter((item) => item !== ''),
    cwd,
  };
}

export function denyReason(probe: GrepProbe): string {
  return [
    `Denied: \`${probe.tool}\` over source (${probe.paths.join(' ')}) — this repo is CodeGraph-indexed, and a grep-and-read sweep repeats work the index already did.`,
    'Run instead (MCP codegraph_explore, or the shell form):',
    '  codegraph explore "<question>"                  # how X works, a bug, where X is: one call usually answers it',
    '  codegraph explore "<X> <Y>"                     # how X reaches Y: name the symbols that span the flow',
    '  codegraph explore "<file or symbol>"            # read or edit it: line-numbered source, safe to Edit from',
    'grep/find/cat are allowed only for prose, config, env files, logs and lockfiles: point them at docs/ or',
    "restrict them to those files, e.g. grep --include='*.md', rg -g '*.md' / --type md, find -name '*.md'.",
  ].join('\n');
}

export function indexMissingReason(probe: GrepProbe, root: string): string {
  return [
    `Denied: \`${probe.tool}\` over source (${probe.paths.join(' ')}) — this repo is CodeGraph-indexed, but the index is missing (${path.join(root, '.codegraph', 'codegraph.db')}).`,
    'Build it, then query it:',
    '  codegraph init .                                # about a second',
    '  codegraph explore "<question or names>"         # one call usually answers it',
    'grep/find/cat over source is not the alternative; they are allowed only for prose, config, env files, logs and lockfiles.',
  ].join('\n');
}

/** The shared decision for a probe built from either the shell or the Grep tool. */
export function decideProbe(probe: GrepProbe, ctx: GuardContext): GuardDecision | null {
  const sourceScoped = probe.paths.some(
    (operand) => classifyOperand(operand, probe.cwd, ctx.root) === 'source',
  );
  if (!sourceScoped) return null;

  const restrictorsNeutralise =
    probe.restrictors.length > 0 &&
    probe.restrictors.every((glob) => restrictorAdmitsOnlyAllowed(glob, probe.cwd, ctx.root));
  const typesNeutralise = probe.types.length > 0 && probe.types.every(typeAdmitsOnlyAllowed);
  if (restrictorsNeutralise || typesNeutralise) return null;

  return {
    kind: 'deny',
    reason: ctx.indexPresent ? denyReason(probe) : indexMissingReason(probe, ctx.root),
  };
}

export function evaluateSourceGrepCommand(
  command: SimpleCommand,
  ctx: GuardContext,
): GuardDecision | null {
  if (command.hasHelp) return null;
  const probe = probeFromCommand(command);
  return probe === null ? null : decideProbe(probe, ctx);
}

/** Claude's built-in `Grep` tool: `{pattern, path?, glob?, type?}`. */
export function evaluateGrepTool(
  toolInput: Readonly<Record<string, unknown>>,
  ctx: GuardContext,
): GuardDecision | null {
  const pathInput = toolInput.path;
  const glob = toolInput.glob;
  const type = toolInput.type;
  const probe: GrepProbe = {
    tool: 'Grep',
    paths: [typeof pathInput === 'string' && pathInput !== '' ? pathInput : '.'],
    restrictors: typeof glob === 'string' && glob !== '' ? [glob] : [],
    types: typeof type === 'string' && type !== '' ? [type] : [],
    cwd: ctx.cwd,
  };
  return decideProbe(probe, ctx);
}
