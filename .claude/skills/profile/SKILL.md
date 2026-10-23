---
name: profile
description: Find where Merkur spends time - the Rust dataplane (merkur profile record, bun run profile:sim, SQL through profile:query and profile:diff), a slow Bazel build or test run (bun run profile:query bazel bazel-critical-path, a cache miss), Bun and TypeScript workloads (profile-project.ts --cpu-profile/--heap-profile), and browser presentation (DIRECT_GPU_TRACE). Use when asked to profile, find a hot path, explain a slow flush, keystroke, build, test run or CI job, check what a change did to the dataplane's time, or add a span.
---

# Profiling Merkur

Pick the tool by what is slow, then answer in numbers a rerun reproduces. Timings from a run
with a recorder on are diagnostic, never acceptance; a decision needs the release build's
benchmark and the null-control discipline in `docs/performance.md`.

| What is slow | Tool | Where |
| --- | --- | --- |
| A dataplane stage, a flush, a keystroke in the daemon | spans and CPU samples, in SQL | Profiling the dataplane, below |
| A build, a test run, a CI job | Bazel's own profile, in the same SQL | Profiling the build, below |
| A Bun service or script | `bun run scripts/profile-project.ts --mode=micro --cpu-profile --heap-profile` | `docs/performance.md` (Profiling Commands) |
| A browser frame or presentation | `DIRECT_GPU_TRACE=1` and `scripts/analyze-terminal-gpu-trace.ts` | `docs/performance.md` (Correlating terminal surfaces) |
| The Linux edge under load | `bun run profile:edge:prepare`, `profile:edge:linux` | `docs/performance.md` (Authenticated Linux edge profiling) |

`bun run profile:setup` installs the pinned `trace_processor_shell` and samply into
`~/.cache/merkur/profile-tools` once per machine; on macOS it code-signs samply so it can attach.

## Profiling the dataplane

The dataplane records spans and boundary evidence in `packages/merkur-trace`; samply samples
its CPU; `@merkur/profile` (`packages/profile`) merges both into one Perfetto trace and runs the
SQL in `packages/profile/queries/`. `docs/performance.md` (Native span profiling) is the
contract.

### Pick the capture

- A live session, as the owner uses it: `merkur profile record --seconds 10 --cpu` against
  the running daemon, which must run this checkout's dataplane for new span sites to
  appear. Restarting the owner's daemon drops their sessions: ask first.
- One component, edited and remeasured in seconds: `bun run profile:sim --rounds 2000`
  (add `--cpu` for samples). It runs the production flush and preparation worker in the
  display simulator, built by Cargo's incremental `profiling` profile, which rebuilds the
  dataplane after a one-line edit in seconds where Bazel's whole-crate release build takes
  tens of seconds.
- Linux without a Linux machine: dispatch the Profile workflow (`.github/workflows/profile.yml`).

Each prints a directory. A `--cpu` failure is samply's, with its reason; spans need no
privileges.

### Ask the question

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

### Compare two builds

1. Same base: two scratch worktrees, or one checkout with and without the patch.
2. Run `profile:sim` without `--cpu` for each arm, alternating at least three times.
   `run.json` holds instructions retired, which a layout change does not move; lead with it.
3. `bun run profile:diff <a> <b> span-percentiles` for the span picture.

The decision itself is the release benchmark: `bun run bench:display-pipeline:rust` and kin,
which run `//apps/daemon/dataplane:unit_release`.

### Add a span

`let _span = merkur_trace::span!("area.stage");` at the top of the stage, or
`merkur_trace::span!("area.stage", value)` to carry a size or count. `mark!` records an
instant; two marks sharing a value join a hop between threads. Spans belong at stage
boundaries, never in a per-cell or per-byte loop: a disabled span costs one load, an
enabled one 1.4 ns. A span must open and close on one thread. A crate the browser also
compiles (`merkur-codec`, `merkur-fec`) takes `merkur-trace` as a dependency on both sides:
its Bazel `deps`, and its WebAssembly workspace (`bun run build:wasm-workspaces`), where every
call is a no-op. Name the new site in `docs/performance.md`'s list.

## Profiling the build

Bazel writes a trace of every command to `<output_base>/command.profile.gz`, Chrome's trace
format, which `trace_processor` reads as is; `bazel` names this checkout's last one. Run the
command, then ask:

```sh
bun run profile:query bazel bazel-phases          # analysis against execution, in seconds
bun run profile:query bazel bazel-critical-path   # the chain no parallelism shortens
bun run profile:query bazel bazel-slow-actions --limit 20
bun run profile:query bazel bazel-waits           # time actions waited for CPUs (--jobs, load)
bun run profile:query bazel bazel-categories      # analysis, fetching or execution
```

Copy a profile aside (`cp "$(bazel info output_base)/command.profile.gz" a.json.gz`) to keep it,
and `bun run profile:diff a.json.gz b.json.gz bazel-slow-actions` compares two runs.

- A long "Load, analyze" phase with "Fetching repository" or `crate_universe` in
  `bazel-categories` is a module extension re-evaluating; the server log
  (`$(bazel info output_base)/java.log`) says "Discarding analysis cache because…" when a
  changed `--config` or flag threw the analysis away. Prefer a `release_binary` target to
  `--config=release`.
- A test that should have been cached and was not: `bazel test //... --explain=<file>` names
  the changed input. To compare against CI's cache, run both sides with
  `--execution_log_compact_file=<file>` and diff the two logs' inputs for the action.
- A Bun test's inputs are its module target (`tools/bazel/modules.bzl`); a test that reruns too
  often depends on more than it reads, often through a literal URL naming a directory or the
  repository's root.
- On CI, the BuildBuddy invocation link the job prints shows the same timing and every cache
  miss.
