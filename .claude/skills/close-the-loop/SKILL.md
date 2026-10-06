---
name: close-the-loop
description: Sweep Merkur's prose for drift after a code change - run check:docs and doc-drift, then re-read the docs the change implicates. Use before reporting work done, when asked to update docs, sweep for drift, close the loop on documentation, or when a rename, moved file, changed constant, script, env var, or invariant needs its prose updated.
---

# Closing the loop on documentation

Prose is part of the cutover, not a follow-up: a change that leaves the docs describing
the old behaviour is unfinished, and stale guidance is worse than none because the next
agent trusts it. Once the code is written and the selected gates are green, sweep for
drift before reporting the work done.

1. `bun run check:docs`: every backticked repo path and `bun run` script must resolve,
   markdown links must resolve, pinned facts (codec version, loss threshold, dictionary
   message types, zstd knees, wrap flag, token TTL bounds) must match their source, the
   README config table and `apps/server/.env.example` must match the loader, the README
   e2e and gate tables must equal `bun run generate:docs` output,
   the README workspace table must list every manifest member, and the harness files must
   keep their shape.
2. `bun run scripts/doc-drift.ts --since <base>`: lists identifiers, paths, script names,
   env vars and literal values your diff removed or changed that prose still mentions.
   Every line is a judgement call; fix the ones your change invalidated.
3. Re-read what the change implicates:

| You changed | Re-read |
| --- | --- |
| An architecture boundary, an invariant, a directory's purpose | `AGENTS.md` (map, index, principles) and the matching `.claude/rules/*.md` |
| Transport, NAT, or direct-path behaviour | `docs/transport.md` |
| Display encoding, ACK, presentation, compression | `docs/display-invariants.md` |
| Any crypto, gate, token, or trust boundary | `docs/security.md` |
| Daemon or box process lifecycle and supervision | `docs/processes.md` |
| A hot-path design, plus every benchmark you ran | `docs/performance.md` for the design; the outcome is a dated record, which this tree does not hold |
| Health states, signal formats, metric names, redaction, exporters | `docs/observability.md` |
| Release, signing, or rollout mechanics | `docs/releases.md` |
| A `package.json` script, its behaviour, or its cost | the README script list and `.claude/skills/verify/SKILL.md` |

Dated records, open items and unbuilt designs are not kept in this repository. Reference
docs under `docs/` stay undated, hold no results, and never mention or link such a record;
`check:docs` refuses a bare date there.

Two failure modes. Do not rewrite prose your change did not invalidate; an unrelated doc
edit is scope creep. And do not paper over a contradiction between a doc and the code:
say so, because one of the two is a bug.
