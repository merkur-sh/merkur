@AGENTS.md

## Claude Code only

- CodeGraph is the MCP tool `mcp__codegraph__codegraph_explore`; if it is listed but
  deferred, load it with ToolSearch before the first lookup. In a worktree, pass its path
  as `projectPath` once it has its own index (`codegraph init .`; a nested worktree
  without one resolves to the primary's). The shell form keeps no session state, so it
  tracks neither what it sent nor the call budget.
- Query CodeGraph yourself, in plan mode too; never hand a code lookup to a subagent.
  Explore's saving is the current, `Edit`-safe source it leaves in the caller's context,
  under that session's call budget. A subagent spends its own budget, its copy is thrown
  away with its context, and its paraphrase sends you back for the same source before an
  edit. Explore and Plan also skip CLAUDE.md, so they grep and the hook denies it. Fan out
  only a large audit or migration whose units share little code, one unit per
  general-purpose subagent, and check each report's evidence before accepting it.
- `.claude/rules/*.md` load by their `paths:`; skills load by description. Run `/context`
  to confirm what loaded.
- Bypass mode suggests reading files with `cat`/`sed` and editing with `sed`, heredocs or
  scripts. On repo source both cost a round trip or skip a check: the PreToolUse hook
  denies the read (put the path or symbol in a `codegraph_explore` query instead), and the
  Biome hook and the plan gate see only `Edit`/`Write`/`MultiEdit`, so a Python or
  `sed -i` edit bypasses them. Edit repo files with the edit tools.
- Changes under `packages/auth`, `packages/merkur-e2e`,
  `apps/daemon/dataplane/src/session`, and `packages/merkur-identity-seal` need
  an approved plan. The PreToolUse hook denies `Edit`/`Write` there until `ExitPlanMode`
  has completed in the session (`scripts/agent-hooks/guards/plan-gate.ts`).
- A step that needs nothing from the owner is not a stopping point: no summary that names
  the next step without taking it, no offer to continue, no list of options that do not
  block the work. Put a status note in the same message as the next action; stop only for
  the scope, access, approval or destructive-action blockers AGENTS.md names.
- Wait on builds, CI and harnesses with `run_in_background` or Monitor, never `sleep`,
  and follow them to the end rather than ending the turn.
- For a Codex second opinion: `codex exec -s read-only -C <repo> --ephemeral --color never
  -o <scratchpad>/answer.md - < <scratchpad>/brief`. Codex reads AGENTS.md itself, so the
  brief holds only the question, the evidence and the allowed paths. The owner's own Codex
  sessions are in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Auto-memory holds Claude-only traps and settled decisions. A lesson Codex also needs
  goes in AGENTS.md or a rule; an undecided direction goes nowhere.
- A multi-part run keeps its checklist in a scratchpad file, ticked as items land and
  extended as new ones turn up; compaction summarizes the conversation, not the file.
  When compacting, preserve the list of modified files, the gate commands already run and
  their results, and any open drift findings. After compaction, an explore "already sent"
  pointer can name source the summary dropped; put the file path in the query, which
  always returns the file in full.
