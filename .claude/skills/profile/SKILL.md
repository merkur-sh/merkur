---
name: profile
description: Find where Merkur's Rust dataplane spends time and CPU - capture a live session with merkur profile record, or the simulated display pipeline with bun run profile:sim, then answer in SQL with bun run profile:query and compare two captures with profile:diff. Use when asked to profile, find a hot path, explain a slow flush or keystroke, check what a change did to the dataplane's time, or add a span.
---

# Profiling the dataplane

The dataplane records spans and boundary evidence in `packages/merkur-trace`; samply samples
its CPU; `@merkur/profile` (`packages/profile`) merges both into one Perfetto trace and runs the
SQL in `packages/profile/queries/`. `docs/performance.md` (Native span profiling) is the
contract; this is the procedure.

## Once per machine

`bun run profile:setup` installs the pinned `trace_processor_shell` and samply into
`~/.cache/merkur/profile-tools`. On macOS it code-signs samply so it can attach.

## Pick the capture

- A live session, as the owner uses it: `merkur profile record --seconds 10 --cpu` against
  the running daemon, which must run this checkout's dataplane for new span sites to
  appear. Restarting the owner's daemon drops their sessions: ask first.
- One component, edited and remeasured in seconds: `bun run profile:sim --rounds 2000`
  (add `--cpu` for samples). It runs the production flush and preparation worker in the
  display simulator.
- Linux without a Linux machine: dispatch the Profile workflow (`.github/workflows/profile.yml`).

Each prints a directory. A `--cpu` failure is samply's, with its reason; spans need no
privileges.

## Ask the question

```sh
bun run profile:query <dir> span-percentiles        # where time goes, by span
bun run profile:query <dir> flush-breakdown         # the owner-to-worker hop of each prepare
bun run profile:query <dir> slow-spans --span display.pack --limit 10
bun run profile:query <dir> cpu-in-slow-spans --span display.flush --threshold-us 200
bun run profile:query <dir> cpu-top
```

`--json` gives rows for further processing. A new question is a new `.sql` file in
`packages/profile/queries/` with `{{span}}`, `{{threshold_us}}` and `{{limit}}` as its only
parameters; read `slice`, `thread_track`, `thread`, `perf_sample`, `stack_profile_*` and
`args` (a span's value is `debug.value`).

## Compare two builds

1. Same base: two scratch worktrees, or one checkout with and without the patch.
2. Run `profile:sim` without `--cpu` for each arm, alternating at least three times.
   `run.json` holds instructions retired, which a layout change does not move; lead with it.
3. `bun run profile:diff <a> <b> span-percentiles` for the span picture.

Timings from a capture with the recorder on are diagnostic, never acceptance. A decision
needs the Bazel release build's benchmark (`bun run bench:display-pipeline:rust` and kin) and
the null-control discipline in `docs/performance.md`.

## Add a span

`let _span = merkur_trace::span!("area.stage");` at the top of the stage, or
`merkur_trace::span!("area.stage", value)` to carry a size or count. `mark!` records an
instant; two marks sharing a value join a hop between threads. Spans belong at stage
boundaries, never in a per-cell or per-byte loop: a disabled span costs one load, an
enabled one 1.4 ns. A span must open and close on one thread. A crate the browser also
compiles (`merkur-codec`, `merkur-fec`) takes `merkur-trace` as a dependency on both sides:
its Bazel `deps`, and its WebAssembly workspace (`bun run build:wasm-workspaces`), where every
call is a no-op. Name the new site in `docs/performance.md`'s list.
