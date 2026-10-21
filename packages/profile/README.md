# Native trace profiling

`@merkur/profile` reads what the dataplane records and answers questions about it in SQL.

- `src/mtrace.ts` reads a `.mtrace` capture, which `packages/merkur-trace` writes. The
  e2e oracles read their evidence through it too.
- `src/samply.ts` reads the CPU profile `samply record --presymbolicate` writes.
- `src/perfetto.ts` writes both into one Perfetto trace. Spans become slices on their
  thread's track, marks become instants, and samples become `PerfSample`s, all on the
  anchor clock the two share.
- `queries/*.sql` are the questions, run by the pinned `trace_processor_shell`.

## Commands

```sh
bun run profile:setup                                # once per machine
merkur profile record --seconds 10 --cpu             # prints the capture directory
bun run profile:query <dir> span-percentiles
bun run profile:query <dir> flush-breakdown
bun run profile:query <dir> cpu-in-slow-spans --span display.pack --threshold-us 100
bun run profile:diff <before-dir> <after-dir> span-percentiles
bun run profile:perfetto <dir>                       # <dir>/trace.perfetto-trace, for ui.perfetto.dev
```

`profile:query` builds `trace.perfetto-trace` when the capture is newer than it. Options:
`--span <site>`, `--threshold-us <n>`, `--limit <n>`, `--json`.

| Query | Answers |
| --- | --- |
| `span-percentiles` | p50, p90, p99 and max of every span name, by total time |
| `slow-spans` | the slowest spans named `--span`, with each child span inside them |
| `cpu-in-slow-spans` | self time inside `--span` spans of at least `--threshold-us`, from samples of the span's thread inside its window |
| `cpu-top` | self time by thread and function across the capture |
| `flush-breakdown` | each display preparation's hop: queued on the worker, prepared, returned to the owner, total |

## Pinned tools

`profile:setup` installs both into `~/.cache/merkur/profile-tools` (`MERKUR_PROFILE_TOOLS`
moves it). Perfetto `trace_processor_shell` comes from the `v58.2` release archive, checked
against the sha256 in `src/tools.ts` for macOS arm64 and Linux amd64 and arm64. samply is
built from commit `247df8fe`, the first whose profiles state their zero on the anchor clock
(`startTimeAsMachAbsoluteTimeNanoseconds`, `startTimeAsClockMonotonicNanosecondsSinceBoot`),
so its samples need no alignment estimate. `trace_processor` cannot read that profile
format, which is why `perfetto.ts` writes the samples itself. On macOS, setup code-signs
samply so it can attach to a running dataplane; `merkur profile --cpu` stops it with SIGINT
while the dataplane still runs, the only stop its macOS attach honours.

CPU sampling needs `perf_event_open` on Linux. Where a container or sandbox refuses it,
samply fails and `merkur profile record --cpu` reports it; spans and queries need no
privileges.
