import { expect, test } from 'bun:test';

import {
  type ClippyFinding,
  type ClippyRun,
  classify,
  clippyCommand,
  diagnosticFiles,
  formatClippyBaseline,
  hostTriple,
  judgeElsewhere,
  parseClippyBaseline,
  RATCHETED_LINTS,
  readClippy,
  renderUnplaced,
  sortFindings,
  tightenRefusal,
  unverifiedReason,
  zeroFailures,
} from './rust-lint';

const ROOT = '/repo';

const TRUNCATION = 'clippy::cast_possible_truncation';

/** What rustc writes before its diagnostics: the dependency file it emitted. */
const ARTIFACT = JSON.stringify({
  $message_type: 'artifact',
  artifact: 'bazel-out/darwin_arm64-fastbuild/bin/packages/merkur-fec/merkur_fec-1.d',
  emit: 'dep-info',
});

/** A span as rustc writes it: `expansion` is the macro call the span came out of. */
interface Span {
  readonly file_name: string;
  readonly line_start: number;
  readonly column_start: number;
  readonly is_primary: boolean;
  readonly expansion: { readonly span: Span; readonly macro_decl_name: string } | null;
}

function span(file: string, line: number, column: number, from?: Span): Span {
  return {
    file_name: file,
    line_start: line,
    column_start: column,
    is_primary: true,
    expansion: from === undefined ? null : { span: from, macro_decl_name: 'assert_eq!' },
  };
}

/** One diagnostic line, its `rendered` coloured as rustc colours it for a terminal. */
function message(
  code: string | null,
  spans: readonly Span[],
  text: string,
  level = 'warning',
): string {
  return JSON.stringify({
    $message_type: 'diagnostic',
    message: text,
    code: code === null ? null : { code, explanation: null },
    level,
    spans,
    children: [],
    rendered: `\u001b[1m${level}\u001b[0m: ${text}\n`,
  });
}

/** rustc's closing count of a crate's warnings. */
function summary(count: number): string {
  return message(null, [], `${count} warning${count === 1 ? '' : 's'} emitted`);
}

function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function read(...files: readonly string[]): ClippyRun {
  return readClippy(files, ROOT);
}

function finding(path: string, rule: string, line: number, column: number): ClippyFinding {
  const rendered = [
    `warning: message of ${rule}`,
    `  --> ${path}:${line}:${column}`,
    '   |',
    '   = help: the suggestion',
    '',
    '',
  ].join('\n');

  return { file: path, rule, line, column, message: `message of ${rule}`, rendered };
}

test('a diagnostic every target reports is one finding at its primary span', () => {
  const cast = 'casting `usize` to `u8` may truncate the value';
  const secondary = { ...span('packages/merkur-fec/src/codec.rs', 12, 1), is_primary: false };
  const library = file(
    ARTIFACT,
    message(TRUNCATION, [span('packages/merkur-fec/src/codec.rs', 69, 24)], cast),
    message(TRUNCATION, [span('packages/merkur-fec/src/codec.rs', 69, 36)], cast),
    message(
      'clippy::cast_sign_loss',
      [secondary, span('packages/merkur-fec/src/codec.rs', 69, 24)],
      'casting `i32` to `u8` may lose the sign of the value',
    ),
    summary(3),
  );
  // The library's test target compiles the same module and says it again.
  const tests = file(
    message(TRUNCATION, [span('packages/merkur-fec/src/codec.rs', 69, 24)], cast),
    message(
      'unused_variables',
      [span('/repo/apps/edge/src/relay.rs', 7, 9)],
      'unused variable: `x`',
    ),
    summary(2),
  );

  const run = read(library, tests);

  expect(run).toEqual({
    findings: [
      {
        file: 'packages/merkur-fec/src/codec.rs',
        rule: TRUNCATION,
        line: 69,
        column: 24,
        message: cast,
        rendered: `warning: ${cast}\n`,
      },
      {
        file: 'packages/merkur-fec/src/codec.rs',
        rule: TRUNCATION,
        line: 69,
        column: 36,
        message: cast,
        rendered: `warning: ${cast}\n`,
      },
      {
        file: 'packages/merkur-fec/src/codec.rs',
        rule: 'clippy::cast_sign_loss',
        line: 69,
        column: 24,
        message: 'casting `i32` to `u8` may lose the sign of the value',
        rendered: 'warning: casting `i32` to `u8` may lose the sign of the value\n',
      },
      {
        file: 'apps/edge/src/relay.rs',
        rule: 'unused_variables',
        line: 7,
        column: 9,
        message: 'unused variable: `x`',
        rendered: 'warning: unused variable: `x`\n',
      },
    ],
    unplaced: [],
  });
  expect(unverifiedReason(run, 0)).toBeNull();
});

test('a diagnostic inside a macro of another crate is placed where this repository expands it', () => {
  const call = span('apps/edge/src/relay.rs', 412, 9);
  const core = '/rustc/8bab26f4f68e/library/core/src/macros/mod.rs';
  const local = span('apps/edge/src/macros.rs', 5, 13, span('apps/edge/src/splice.rs', 80, 5));
  const nested = span(
    'external/rules_rust++crate+crates__proptest-1.11.0/src/sugar.rs',
    3,
    1,
    span(core, 9, 9, call),
  );

  const run = read(
    file(
      message('clippy::float_cmp', [span(core, 45, 22, call)], 'strict comparison of `f32`'),
      message('clippy::panic', [local], '`panic` should not be present in production code'),
      message('clippy::unwrap_used', [nested], 'used `unwrap()` on an `Option` value'),
      message('clippy::float_cmp', [span(core, 45, 22)], 'strict comparison of `f32`'),
    ),
  );

  expect(run.findings.map((found) => [found.rule, found.file, found.line, found.column])).toEqual([
    ['clippy::float_cmp', 'apps/edge/src/relay.rs', 412, 9],
    // A macro of this repository is a place of its own.
    ['clippy::panic', 'apps/edge/src/macros.rs', 5, 13],
    ['clippy::unwrap_used', 'apps/edge/src/relay.rs', 412, 9],
  ]);
  expect(run.unplaced).toEqual(['warning: strict comparison of `f32`\n']);
});

test('a span in an external repository or a Bazel output is outside this repository', () => {
  const run = read(
    file(
      message(
        'dead_code',
        [span('external/rules_rust++crate+crates__quinn-0.11.12/src/lib.rs', 4, 1)],
        'unused',
      ),
      message('dead_code', [span('bazel-out/darwin_arm64-fastbuild/bin/x/out.rs', 2, 1)], 'unused'),
      message('dead_code', [span('apps/edge/src/relay.rs', 4, 1)], 'unused'),
    ),
  );

  expect(run.findings.map((found) => [found.rule, found.file])).toEqual([
    ['dead_code', 'apps/edge/src/relay.rs'],
  ]);
  expect(run.unplaced).toEqual(['warning: unused\n', 'warning: unused\n']);
});

test('the diagnostics files are those of the aspect output group, through nested sets', () => {
  const aspect = '//tools/bazel/rust:clippy.bzl%clippy_diagnostics';
  const events = file(
    JSON.stringify({
      id: { namedSet: { id: '0' } },
      namedSetOfFiles: {
        files: [
          {
            name: 'a.clippy.diagnostics',
            pathPrefix: ['bazel-out', 'k8', 'bin'],
            uri: 'bytestream://c/a',
          },
        ],
      },
    }),
    JSON.stringify({
      id: { namedSet: { id: '1' } },
      namedSetOfFiles: {
        files: [{ name: 'b.clippy.diagnostics', pathPrefix: ['bazel-out', 'k8-ST-1', 'bin'] }],
        fileSets: [{ id: '0' }],
      },
    }),
    JSON.stringify({
      id: { namedSet: { id: '2' } },
      namedSetOfFiles: { files: [{ name: 'c.rlib', pathPrefix: ['bazel-out', 'k8', 'bin'] }] },
    }),
    JSON.stringify({
      id: { targetCompleted: { label: '//apps/edge:unit', aspect } },
      completed: {
        success: true,
        outputGroup: [{ name: 'clippy_diagnostics', fileSets: [{ id: '1' }] }],
      },
    }),
    // The target itself, and any other output group, are not Clippy's.
    JSON.stringify({
      id: { targetCompleted: { label: '//apps/edge:unit' } },
      completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '2' }] }] },
    }),
    JSON.stringify({
      id: { targetCompleted: { label: '//apps/edge:lints', aspect } },
      completed: { success: true },
    }),
  );

  // Under the execution root, whatever cache the event's URI names.
  expect(diagnosticFiles(events)).toEqual([
    'bazel-out/k8-ST-1/bin/b.clippy.diagnostics',
    'bazel-out/k8/bin/a.clippy.diagnostics',
  ]);

  const failed = file(
    JSON.stringify({
      id: { targetCompleted: { label: '//apps/edge:unit', aspect } },
      completed: { success: false },
    }),
  );

  expect(() => diagnosticFiles(failed)).toThrow('Clippy did not complete for //apps/edge:unit');
  expect(() =>
    diagnosticFiles(
      file(
        JSON.stringify({
          id: { targetCompleted: { label: '//apps/edge:unit', aspect } },
          completed: {
            success: true,
            outputGroup: [{ name: 'clippy_diagnostics', fileSets: [{ id: '9' }] }],
          },
        }),
      ),
    ),
  ).toThrow("Bazel's events name no file set 9");
  expect(() => diagnosticFiles('not json\n')).toThrow('Bazel wrote an event that is not JSON');
});

test('a message without a lint code or a place leaves the run unverified', () => {
  const run = read(
    file(
      message(null, [span('apps/stun/src/main.rs', 3, 1)], 'expected one of `!` or `::`', 'error'),
      message('unused_imports', [], 'unused import: `std::fmt`'),
      message(TRUNCATION, [span('apps/stun/src/main.rs', 9, 4)], 'casting `u64` to `u8`'),
    ),
  );

  expect(run.findings).toHaveLength(1);
  expect(run.unplaced).toEqual([
    'error: expected one of `!` or `::`\n',
    'warning: unused import: `std::fmt`\n',
  ]);
  expect(unverifiedReason(run, 0)).toBe(
    '2 compiler messages carry no lint code or no place in this repository',
  );
  // What could not be counted is still shown, as the compiler rendered it.
  expect(renderUnplaced(run.unplaced)).toBe(
    [
      'FAIL  compiler messages with no lint code or no place in this repository:',
      '    error: expected one of `!` or `::`',
      '    warning: unused import: `std::fmt`',
      '',
    ].join('\n'),
  );
  expect(renderUnplaced([])).toBe('');
});

test("rustc's count of a file's warnings is read only as that count", () => {
  const cast = message(TRUNCATION, [span('apps/stun/src/main.rs', 9, 4)], 'casting `u64` to `u8`');

  expect(read(file(cast, cast, summary(2))).unplaced).toEqual([]);
  expect(read(file(summary(0))).unplaced).toEqual([]);
  // A count that does not match what the file reported is a message like any other.
  expect(read(file(cast, summary(3))).unplaced).toEqual(['warning: 3 warnings emitted\n']);
  // The count belongs to its own file.
  expect(read(file(cast), file(summary(1))).unplaced).toEqual(['warning: 1 warning emitted\n']);
});

test('a file that is not rustc JSON is no answer, and neither is a failed build', () => {
  expect(() => read('warning: unused manifest key\n')).toThrow(
    'rustc wrote a line that is not a diagnostic: warning: unused manifest key',
  );
  expect(() => read(file('{"$message_type":"diagnostic"}'))).toThrow(
    'rustc wrote a diagnostic with no level, message or spans',
  );

  const run = read(
    file(message('E0308', [span('apps/edge/src/relay.rs', 20, 5)], 'mismatched types', 'error')),
  );

  expect(sortFindings(run.findings).zero).toEqual([
    {
      file: 'apps/edge/src/relay.rs',
      rule: 'E0308',
      line: 20,
      column: 5,
      message: 'mismatched types',
      rendered: 'error: mismatched types\n',
    },
  ]);
  expect(unverifiedReason(run, 1)).toBe('bazel build exited 1');
  expect(unverifiedReason(read(), 1)).toBe('bazel build exited 1');
});

test('every finding has exactly one class, from its lint and its file', () => {
  const table: (readonly [code: string, file: string, lintClass: string])[] = [
    // Zero everywhere: whatever is not a ratcheted lint.
    ['unused_variables', 'apps/daemon/dataplane/src/main.rs', 'zero'],
    ['dead_code', 'packages/vte-patch/src/lib.rs', 'zero'],
    ['clippy::needless_return', 'apps/tui/src/main.rs', 'zero'],
    ['clippy::needless_return', 'packages/alacritty-terminal-patch/src/grid.rs', 'zero'],
    ['clippy::undocumented_unsafe_blocks', 'apps/edge/src/relay.rs', 'zero'],
    ['clippy::redundant_clone', 'packages/merkur-codec/src/lib.rs', 'zero'],
    ['unfulfilled_lint_expectations', 'packages/merkur-client/src/session.rs', 'zero'],
    ['E0308', 'apps/stun/src/main.rs', 'zero'],
    // Zero: the panic lints in the panic-free crates.
    ['clippy::indexing_slicing', 'packages/merkur-wire/src/protocol.rs', 'zero'],
    ['clippy::unwrap_used', 'packages/merkur-stun-protocol/src/message.rs', 'zero'],
    ['clippy::expect_used', 'packages/merkur-edge-protocol/src/lib.rs', 'zero'],
    ['clippy::unreachable', 'packages/merkur-wire/src/signaling.rs', 'zero'],
    ['clippy::string_slice', 'packages/merkur-wire/src/terminal_ui.rs', 'zero'],
    ['clippy::get_unwrap', 'packages/merkur-stun-protocol/src/lib.rs', 'zero'],
    // The two lints on both lists are zero there too: the panic-free crates come first.
    ['clippy::panic', 'packages/merkur-wire/src/input_record.rs', 'zero'],
    ['clippy::unwrap_in_result', 'packages/merkur-edge-protocol/src/lib.rs', 'zero'],
    // Zero: a timer call, which first-party code reports only from a module that denies it.
    ['clippy::disallowed_methods', 'apps/daemon/dataplane/src/pty/writer.rs', 'zero'],
    ['clippy::disallowed_methods', 'packages/merkur-client/src/viewer/receive.rs', 'zero'],
    ['clippy::disallowed_methods', 'apps/edge/src/splice.rs', 'zero'],
    // Baseline, whole first-party tree.
    ['clippy::map_err_ignore', 'apps/daemon/dataplane/src/auth.rs', 'baseline'],
    ['clippy::let_underscore_must_use', 'apps/tui/src/main.rs', 'baseline'],
    ['clippy::unwrap_in_result', 'apps/daemon/dataplane/src/pty/spawn.rs', 'baseline'],
    ['clippy::panic', 'packages/merkur-client/src/session.rs', 'baseline'],
    ['clippy::cast_possible_truncation', 'packages/merkur-fec/src/codec.rs', 'baseline'],
    ['clippy::cast_sign_loss', 'packages/term-wasm/src/lib.rs', 'baseline'],
    ['clippy::cast_possible_wrap', 'packages/merkur-graphics/tests/tile.rs', 'baseline'],
    ['clippy::too_many_lines', 'apps/edge/src/relay.rs', 'baseline'],
    // A whole-tree lint that is not a panic lint is baselined in a panic-free crate as anywhere.
    ['clippy::cast_possible_truncation', 'packages/merkur-wire/src/protocol.rs', 'baseline'],
    ['clippy::too_many_lines', 'packages/merkur-stun-protocol/src/message.rs', 'baseline'],
    // Baseline, by path: the panic lints in the panic-ratcheted crates.
    ['clippy::indexing_slicing', 'packages/merkur-codec/src/rows.rs', 'baseline'],
    ['clippy::unwrap_used', 'packages/merkur-fec/tests/recover.rs', 'baseline'],
    ['clippy::expect_used', 'packages/merkur-e2e/src/noise.rs', 'baseline'],
    ['clippy::unreachable', 'apps/stun/src/main.rs', 'baseline'],
    ['clippy::string_slice', 'apps/edge/src/splice.rs', 'baseline'],
    ['clippy::get_unwrap', 'apps/edge/src/bin/delay_proxy.rs', 'baseline'],
    // Ignored: the panic lints anywhere else.
    ['clippy::indexing_slicing', 'apps/daemon/dataplane/src/display/send.rs', 'ignored'],
    ['clippy::unwrap_used', 'apps/tui/src/main.rs', 'ignored'],
    ['clippy::expect_used', 'packages/merkur-client/src/session.rs', 'ignored'],
    ['clippy::unreachable', 'packages/merkur-graphics/src/tile.rs', 'ignored'],
    ['clippy::string_slice', 'packages/term-wasm/src/lib.rs', 'ignored'],
    ['clippy::get_unwrap', 'packages/merkur-e2e-extra/src/lib.rs', 'ignored'],
    // Ignored: every ratcheted lint in a vendored crate.
    ['clippy::cast_possible_truncation', 'packages/vte-patch/src/lib.rs', 'ignored'],
    ['clippy::panic', 'packages/alacritty-terminal-patch/src/term/mod.rs', 'ignored'],
    ['clippy::unwrap_used', 'packages/quinn-proto-patch/src/connection/mod.rs', 'ignored'],
    ['clippy::too_many_lines', 'packages/wtransport-patch/src/endpoint.rs', 'ignored'],
    // Ignored: a timer call in a vendored crate, which reports every one.
    [
      'clippy::disallowed_methods',
      'packages/alacritty-terminal-patch/src/event_loop.rs',
      'ignored',
    ],
    ['clippy::disallowed_methods', 'packages/vte-patch/src/lib.rs', 'ignored'],
  ];

  expect(table.map(([code, file]) => [code, file, classify(code, file)])).toEqual(
    table.map(([code, file, lintClass]) => [code, file, lintClass]),
  );
});

test('the zero class fails a run by itself, each finding as the compiler rendered it', () => {
  const unused = finding('apps/edge/src/relay.rs', 'unused_variables', 7, 9);
  const unwrap = finding('packages/merkur-wire/src/protocol.rs', 'clippy::unwrap_used', 40, 18);
  const earlier = finding('apps/edge/src/relay.rs', 'clippy::needless_return', 3, 5);
  const cast = finding('packages/merkur-fec/src/codec.rs', TRUNCATION, 69, 24);
  const ignored = finding('apps/tui/src/main.rs', 'clippy::unwrap_used', 12, 30);
  const classes = sortFindings([unused, cast, unwrap, ignored, earlier]);

  expect(classes).toEqual({ zero: [unused, unwrap, earlier], baselined: [cast] });
  expect(zeroFailures(classes.zero)).toEqual({
    sections: [
      'FAIL  findings no baseline allows:',
      '  apps/edge/src/relay.rs:3:5 clippy::needless_return',
      '    warning: message of clippy::needless_return',
      '      --> apps/edge/src/relay.rs:3:5',
      '       |',
      '       = help: the suggestion',
      '  apps/edge/src/relay.rs:7:9 unused_variables',
      '    warning: message of unused_variables',
      '      --> apps/edge/src/relay.rs:7:9',
      '       |',
      '       = help: the suggestion',
      '  packages/merkur-wire/src/protocol.rs:40:18 clippy::unwrap_used',
      '    warning: message of clippy::unwrap_used',
      '      --> packages/merkur-wire/src/protocol.rs:40:18',
      '       |',
      '       = help: the suggestion',
      '  A compiler warning, a default or workspace Clippy lint, a panic lint in a panic-free crate and a timer call on a latency path have no baseline: fix the code, or expect the lint where it fires with `#[expect(lint, reason = "…")]`.',
      '',
    ].join('\n'),
    clause: ', 3 findings no baseline allows',
  });
  expect(zeroFailures([])).toEqual({ sections: '', clause: '' });
});

test('on a host the baseline is not for, a run enforces the zero class and says so', () => {
  const mac = 'aarch64-apple-darwin';
  const linux = 'x86_64-unknown-linux-gnu';
  const said = `rust:lint: lint-baselines/clippy.json is for ${mac} and this host is ${linux}: the baseline was not compared`;

  expect(judgeElsewhere(mac, linux, zeroFailures([]))).toEqual({
    code: 0,
    output: [said, 'rust:lint: pass (zero class only)', ''].join('\n'),
  });

  const failures = zeroFailures([finding('apps/edge/src/relay.rs', 'unused_variables', 7, 9)]);

  expect(judgeElsewhere(mac, linux, failures)).toEqual({
    code: 1,
    output: [
      said,
      failures.sections.trimEnd(),
      'rust:lint: FAIL (zero class only, 1 findings no baseline allows)',
      '',
    ].join('\n'),
  });
  expect(tightenRefusal(mac, mac)).toBeNull();
  expect(tightenRefusal(mac, linux)).toBe(
    `rust:lint: refused: lint-baselines/clippy.json is for ${mac} and this host is ${linux}; --tighten runs on the host the baseline is for\n`,
  );
});

test('the baseline names its host and round-trips in one key order', () => {
  const counts = new Map([
    ['packages/merkur-fec/src/codec.rs', new Map([[TRUNCATION, 4]])],
    [
      'apps/edge/src/relay.rs',
      new Map([
        ['clippy::unwrap_used', 2],
        ['clippy::cast_sign_loss', 1],
        ['clippy::panic', 0],
      ]),
    ],
  ]);

  const text = `{
  "host": "aarch64-apple-darwin",
  "files": {
    "apps/edge/src/relay.rs": {
      "clippy::cast_sign_loss": 1,
      "clippy::unwrap_used": 2
    },
    "packages/merkur-fec/src/codec.rs": {
      "${TRUNCATION}": 4
    }
  }
}
`;

  expect(formatClippyBaseline('aarch64-apple-darwin', counts)).toBe(text);

  const parsed = parseClippyBaseline(text);

  expect(parsed.host).toBe('aarch64-apple-darwin');
  expect(formatClippyBaseline(parsed.host, parsed.counts)).toBe(text);
  expect(formatClippyBaseline('x86_64-unknown-linux-gnu', new Map())).toBe(
    '{\n  "host": "x86_64-unknown-linux-gnu",\n  "files": {}\n}\n',
  );

  for (const broken of ['', '{}', '{"files": {}}', '{"host": "h", "files": {"a.rs": {"l": 0}}}']) {
    expect(() => parseClippyBaseline(broken)).toThrow('lint-baselines/clippy.json is not');
  }

  // The layout of the other baselines has no host and is refused.
  expect(() => parseClippyBaseline('{"a.rs": {"clippy::panic": 1}}')).toThrow(
    'lint-baselines/clippy.json is not',
  );
});

test('the host is the Rust triple of the platform Bazel builds for', () => {
  expect(hostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
  expect(hostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
  expect(hostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
  expect(hostTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
  expect(() => hostTriple('win32', 'x64')).toThrow('no Rust target for win32 on x64');
});

test('Clippy is handed every ratcheted lint as a warning, with nothing denied', () => {
  const command = clippyCommand('/tmp/events.json');

  expect(RATCHETED_LINTS).toHaveLength(16);
  expect(command).toEqual([
    'bazel',
    'build',
    '--keep_going',
    '--output_filter=^$',
    '--aspects=//tools/bazel/rust:clippy.bzl%clippy_diagnostics',
    '--output_groups=clippy_diagnostics',
    '--build_event_json_file=/tmp/events.json',
    ...RATCHETED_LINTS.map((lint) => `--@rules_rust//rust/settings:clippy_flag=-W${lint}`),
    '--',
    '//...',
  ]);
  // Every ratcheted lint has a class other than zero somewhere, and zero in no vendored crate.
  expect(RATCHETED_LINTS.map((lint) => classify(lint, 'apps/edge/src/relay.rs'))).toEqual(
    RATCHETED_LINTS.map(() => 'baseline'),
  );
  expect(RATCHETED_LINTS.map((lint) => classify(lint, 'packages/vte-patch/src/lib.rs'))).toEqual(
    RATCHETED_LINTS.map(() => 'ignored'),
  );
});
