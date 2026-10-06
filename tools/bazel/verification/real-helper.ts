import { mkdtempSync, readFileSync, realpathSync, rmdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { openOwnedDirectory, openReadOnlyDirectory } from '../bun/owned-files';

const graphics = 'pty::terminal::graphics::tests::real_helper::';
const native = 'pty::terminal::graphics::native::tests::real_helper::';

/** Exact original REAL_HELPER_LANE inventory, including the authenticated broker. */
export const realHelperCases: readonly string[] = Object.freeze([
  ...[
    'matches_pinned_kitty_core_geometry_and_grid_trace',
    'animation_commands_preserve_placements_and_parser_order',
    'frame_numbers_and_controls_follow_kitty',
    'selectors_delete_selected_descendants_directly',
    'graphics_damage_only_tracks_changed_rows',
    'placeholder_rebinding_is_sparse_and_resolves_late_prototypes',
    'placeholders_follow_grid_edits_and_move_relative_descendants',
    'retained_captures_never_evict_an_original',
    'a_new_placement_keeps_the_versions_of_unchanged_rows',
    'projection_evicts_one_source_per_observed_release',
    'spatial_deletion_sees_placeholder_origins_while_projection_is_deferred',
    'source_authorization_revokes_retained_readers_at_scene_mutations',
    'extent_clipping_controls_deletion_and_source_retention',
    'query_upload_replacement_and_reset',
    'queue_backpressure_preserves_every_chunk_once',
    'an_upload_after_a_delete_answers_alike_in_one_read_or_two',
    'a_shortfall_every_release_leaves_is_answered_once_they_land',
    'a_transfer_in_flight_releases_the_source_a_waiting_upload_needs',
    'an_edit_that_fits_never_waits_for_a_release_in_flight',
    'an_edit_short_of_storage_waits_for_the_releases_in_flight',
    'a_retransmit_over_a_placed_image_admits_no_second_placement',
    'a_projection_right_after_a_delete_evicts_nothing_while_its_release_is_in_flight',
  ].map((name) => graphics + name),
  `${native}references_are_bounded_one_use_terminal_bound_and_reset_fenced`,
  `${native}native_descriptor_is_invisible_until_its_parser_boundary_and_cannot_replay`,
]);

function exactCases(actual: readonly string[], cases: readonly string[]) {
  const required = new Set(cases);
  if (actual.length !== required.size || new Set(actual).size !== actual.length)
    throw new Error('Real helper inventory is incomplete or duplicated');
  for (const name of actual)
    if (!required.has(name)) throw new Error(`Unexpected real helper test: ${name}`);
}

export function nativeGraphicsInventory(
  output: string,
  cases: readonly string[],
): readonly string[] {
  const actual: string[] = [];
  const summaries: number[] = [];
  for (const line of output.trim().split('\n')) {
    if (line === '') continue;
    const summary = /^(\d+) tests?, 0 benchmarks?$/.exec(line);
    if (summary !== null) {
      summaries.push(Number(summary[1]));
      continue;
    }
    const test = /^([^\s]+): test$/.exec(line);
    if (test?.[1] === undefined) throw new Error('Malformed real helper test listing');
    actual.push(test[1]);
  }
  exactCases(actual, cases);
  if (summaries.length !== 1 || summaries[0] !== actual.length)
    throw new Error('Original real helper listing summary is incomplete');
  return Object.freeze(actual);
}

export function verifyNativeGraphicsRun(
  output: string,
  exitCode: number,
  cases: readonly string[],
) {
  if (exitCode !== 0) throw new Error(`Original real helper tests exited ${exitCode}`);
  const actual: string[] = [];
  for (const line of output.split('\n')) {
    const test = /^test (\S+) \.\.\. (\S+)$/.exec(line);
    if (test === null) continue;
    if (test[2] !== 'ok') throw new Error('Original real helper test did not pass');
    if (test[1] !== undefined) actual.push(test[1]);
  }
  exactCases(actual, cases);
  const summaries = [
    ...output.matchAll(
      /test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/g,
    ),
  ];
  const summary = summaries[0];
  if (
    summaries.length !== 1 ||
    summary?.[1] !== 'ok' ||
    Number(summary[2]) !== cases.length ||
    summary[3] !== '0' ||
    summary[4] !== '0' ||
    summary[5] !== '0'
  )
    throw new Error('Original real helper summary is incomplete');
}

export function realHelperInventory(output: string): readonly string[] {
  return nativeGraphicsInventory(output, realHelperCases);
}

export function verifyRealHelperRun(output: string, exitCode: number) {
  verifyNativeGraphicsRun(output, exitCode, realHelperCases);
}

function portable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length !== 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function realHelperInputs(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Real helper inputs must be an engine-generated object');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'harness,target,worker' ||
    !portable(row.harness) ||
    !portable(row.worker) ||
    typeof row.target !== 'string'
  )
    throw new Error('Real helper inputs require exact declared executable paths');
  const targets: Record<string, string> = {
    'aarch64-apple-darwin': 'darwin/arm64',
    'x86_64-apple-darwin': 'darwin/x64',
    'aarch64-unknown-linux-gnu': 'linux/arm64',
    'x86_64-unknown-linux-gnu': 'linux/x64',
  };
  if (targets[row.target] !== `${process.platform}/${process.arch}`)
    throw new Error('Real helper inputs require the actual native execution host');
  if (row.harness === row.worker) throw new Error('Real helper executables must be distinct');
  return { harness: row.harness, worker: row.worker };
}

function capture(file: string) {
  const physical = realpathSync(file);
  const directory = openReadOnlyDirectory(dirname(physical));
  try {
    const member = basename(physical);
    const fact = directory.read(member);
    return {
      bytes: fact.bytes,
      verify() {
        if (realpathSync(file) !== physical) throw new Error('Declared executable carrier changed');
        directory.verify(member);
      },
      close() {
        directory.close();
      },
    };
  } catch (error) {
    directory.close();
    throw error;
  }
}

export async function invokeFixtureCommand(
  args: string[],
  options: { env: Record<string, string>; cwd?: string; signal?: AbortSignal },
) {
  const child = Bun.spawn(args, { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { stdout, stderr, exitCode };
}

export async function runAndRetireFixture(
  run: () => Promise<void>,
  retire: () => void | Promise<void>,
  message: string,
) {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await retire();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0) throw new AggregateError(failures, message);
}

export async function runNativeGraphics(
  request: string,
  runfiles: string,
  temporary: string,
  selection: {
    readonly filter: string;
    readonly cases: readonly string[];
    readonly args: readonly string[];
  },
) {
  if (![request, runfiles, temporary].every(isAbsolute))
    throw new Error('Real helper paths must be absolute engine-owned paths');
  const input = realHelperInputs(JSON.parse(readFileSync(request, 'utf8')));
  const harness = capture(join(runfiles, input.harness));
  try {
    const worker = capture(join(runfiles, input.worker));
    try {
      const root = mkdtempSync(join(realpathSync(temporary), 'real-helper-'));
      const output = openOwnedDirectory(root);
      await runAndRetireFixture(
        async () => {
          output.write('profile/deps/dataplane-test', harness.bytes, 0o500);
          output.write('profile/merkur-image-worker', worker.bytes, 0o500);
          const binary = join(root, 'profile/deps/dataplane-test');
          const verify = () => {
            harness.verify();
            worker.verify();
            output.verify('profile/deps/dataplane-test');
            output.verify('profile/merkur-image-worker');
          };
          verify();
          const listing = await invokeFixtureCommand(
            [binary, '--ignored', selection.filter, '--list'],
            { cwd: root, env: { HOME: root, TMPDIR: root, PATH: '/__no_ambient_path__' } },
          );
          verify();
          if (listing.exitCode !== 0)
            throw new Error('Original real helper inventory query failed');
          nativeGraphicsInventory(listing.stdout, selection.cases);
          const result = await invokeFixtureCommand([binary, ...selection.args], {
            cwd: root,
            env: { HOME: root, TMPDIR: root, PATH: '/__no_ambient_path__' },
          });
          verify();
          verifyNativeGraphicsRun(result.stdout, result.exitCode, selection.cases);
        },
        () => {
          try {
            output.removeCreated();
            rmdirSync(root);
          } finally {
            output.close();
          }
        },
        'Real helper execution refused',
      );
    } finally {
      worker.close();
    }
  } finally {
    harness.close();
  }
}

export async function runRealHelper(request: string, runfiles: string, temporary: string) {
  await runNativeGraphics(request, runfiles, temporary, {
    filter: 'real_helper::',
    cases: realHelperCases,
    args: ['--ignored', 'real_helper::', '--test-threads=1'],
  });
}

export async function nativeGraphicsMain(run: typeof runRealHelper, argumentCount: number) {
  const request = process.env.MERKUR_REAL_HELPER_INPUTS;
  const runfiles = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  const temporary = process.env.TEST_TMPDIR;
  if (
    request === undefined ||
    runfiles === undefined ||
    temporary === undefined ||
    process.argv.length !== argumentCount
  )
    throw new Error('Expected declared inputs, engine runfiles, and private test directory');
  await run(request, runfiles, temporary);
}

if (import.meta.main) await nativeGraphicsMain(runRealHelper, 2);
