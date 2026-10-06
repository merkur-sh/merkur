import path from 'node:path';

import type { GuardDecision } from '../hook-io';
import type { SimpleCommand } from '../shell-command';

/**
 * "`codegraph explore` is the only lookup", mechanised.
 *
 * The MCP server lists only `codegraph_explore`, but the CLI still ships `node`, `query`,
 * `files`, `callers`, `callees` and `impact`, and an agent that reads `codegraph --help` adopts
 * them — Codex, which has no Read tool, took up `node --file` as its file reader and paged
 * through source a window at a time. Each of those is a slice of what one explore call
 * returns, and explore pins every file its query names by path, so every denied form has an
 * explore spelling, listed in the reason. Index maintenance (`init`, `sync`, `index`,
 * `status`, …) and `--help` stay allowed.
 */

const LOOKUP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'node',
  'query',
  'files',
  'callers',
  'callees',
  'impact',
]);

/** The subcommand of a `codegraph` invocation: its first word after the global flags. */
function subcommandOf(argv: readonly string[]): string | null {
  if (path.basename(argv[0] ?? '') !== 'codegraph') return null;
  return argv.slice(1).find((word) => !word.startsWith('-')) ?? null;
}

export function evaluateCodegraphLookup(command: SimpleCommand): GuardDecision | null {
  if (command.hasHelp) return null;
  const sub = subcommandOf(command.argv);
  if (sub === null || !LOOKUP_SUBCOMMANDS.has(sub)) return null;
  return {
    kind: 'deny',
    reason: [
      `Denied: \`codegraph ${sub}\` — \`codegraph explore\` is the one CodeGraph lookup: a single call returns the verbatim line-numbered source, call paths and dependents that \`${sub}\` returns a slice of.`,
      'Run instead (MCP codegraph_explore, or the shell form):',
      '  codegraph explore "<file path>"                 # read a file: a path in the query pins that file',
      '  codegraph explore "<file path> <symbol>"        # one region of a large file',
      '  codegraph explore "<symbol>"                    # its source, callers and callees',
      '  codegraph explore "<X> <Y>"                     # how X reaches Y: name the symbols that span the flow',
    ].join('\n'),
  };
}
