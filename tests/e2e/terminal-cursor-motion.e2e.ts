import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page, TestInfo } from '@playwright/test';
import type { DaemonPerfTraceCapture } from './fixtures/daemon-perf-trace-capture';
import { expect, test } from './fixtures/daemon-process';
import { readDirectTuiViewportSnapshot } from './fixtures/direct-tui-workloads';
import { collectPredictionDiagnostics } from './fixtures/terminal-perf-artifacts';
import { summarizeTuiRedrawCensus } from './fixtures/tui-redraw-census';
import { expectOutput, primeTerminal } from './terminal-e2e-helpers';

/**
 * The cursor the browser draws, in a real session.
 *
 * `display::cursor_lab` drives the same loop natively and can say what a shape
 * of shell output does to the drawn cursor, but it scripts the shell and
 * transcribes the worker's control loop. This runs the actual worker in the
 * actual browser against the actual `/bin/bash` the daemon spawned, and asks
 * one question of it: **while someone types, does the drawn cursor ever step
 * backwards?**
 *
 * The instrument is term-wasm's own journal, armed whenever profiling is on —
 * which the e2e page always is — and surfaced through `postDisplayDiag` as
 * `cursor_stepped_backwards`, carrying the cause code, the columns, and nothing
 * from the terminal's contents. Reading it from the console is deliberate: it
 * is the same line a developer sees while reproducing this by hand.
 */
const BACKWARDS_STEP_EVENT = 'cursor_stepped_backwards';

/**
 * A prompt that opens the shell-editor boundary and then emits `CSI 1 m`.
 *
 * Two things have to be true for this spec to measure anything, and one PS1
 * gives both.
 *
 * The boundary has to be open at all. This suite's readline configuration turns
 * bracketed paste off — deliberately, so a pasted newline still submits — and
 * its disposable `HOME` has no shell integration, so nothing else in it ever
 * opens one and speculative echo has never run under E2E. `OSC 133;B` opens it,
 * unauthenticated, exactly as an existing iTerm2/kitty/starship integration
 * would; the daemon's other two gates (a canonical echoing termios, the
 * foreground process group being the shell) hold at an idle prompt.
 *
 * And the bold has to land *after* that grant, because it is bold arriving
 * inside an open boundary that used to close it: `CSI 1 m`'s payload is `1`, a
 * prefix of `133;`, which a CSI cannot carry. Putting it last does that and
 * costs nothing else — it prints no columns, so the prompt-end anchor the
 * marker just captured is still the exact column the editable region starts at,
 * and what the person types simply renders bold.
 *
 * `\[`/`\]` mark both sequences non-printing for readline's own column
 * accounting; the bytes still reach the daemon.
 */
const BOLD_PROMPT_COMMAND = String.raw`PS1='e2e-cursor$ \[\e]133;B\a\]\[\e[1m\]'`;
/** Typed with the shell echoing every character back. */
const TYPED_LINE = 'echo cursor-motion-ok';
/**
 * Puts the prompt on the bottom row before anything is measured: the state a
 * terminal in use is in, whatever ran before this spec. Enter then scrolls the
 * screen and the next prompt lands on the same row at a lower column, which
 * the journal must read as the next line (the frames' scroll serial), not as a
 * step back. Builtins only: a forked `seq` on a loaded runner held the setup
 * line for seconds.
 */
const PROMPT_TO_BOTTOM = String.raw`printf '%.0s\n' {1..60}`;
/**
 * A command that prints `<name>-ready` once it has run. The marker is never
 * typed verbatim: `expectOutput` matches a substring of everything the terminal
 * shows, and the echo of a typed `printf 'x-ready\n'` satisfies it while the
 * shell has not started the line.
 */
function printReady(name: string): string {
  return String.raw`printf '${name}-%s\n' ready`;
}
/** A human cadence, so each keystroke is predicted and reconciled on its own. */
const KEY_DELAY_MS = (() => {
  // Harness-only override so the same spec can be replayed at the cadence a
  // reporter actually typed at; the default stays the documented human pace.
  const raw = Number(process.env.MERKUR_E2E_KEY_DELAY_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
})();
/**
 * How long the line is left standing before it is submitted.
 *
 * The terminal's accessibility mirror is a log of committed output and does not
 * carry the line still being edited, so there is nothing to poll on: the wait
 * is for the last keystroke's echo to land and reconcile, and Enter would
 * otherwise race it with a prompt redraw. The same 750 ms `primeTerminal` uses
 * to let the mirror settle.
 */
const SETTLE_MS = 750;

/** Collect every backwards-step diagnostic the worker reports from now on. */
function collectBackwardsSteps(page: Page): string[] {
  const steps: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes(BACKWARDS_STEP_EVENT)) steps.push(text);
  });
  return steps;
}

test('typing at a bold prompt never steps the drawn cursor backwards', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);

  // Put the bold into the shell's own prompt, then let it draw once so the
  // sequence has been through the daemon's scanner before anything is measured.
  await page.keyboard.type(
    `${BOLD_PROMPT_COMMAND}; ${PROMPT_TO_BOTTOM}; ${printReady('bold-prompt')}\n`,
  );
  await expectOutput(output, 'bold-prompt-ready');
  // The mirror reports the prompt as soon as it is applied; the anchor it
  // carries is presented one animation frame later, and a key typed inside
  // that frame is refused (`FlushAnchorNotPresented`) and fences every key
  // typed faster than the path behind it. A person's first key is never that
  // close to the prompt; the fish spec settles for the same reason.
  await page.waitForTimeout(SETTLE_MS);

  const backwardsSteps = collectBackwardsSteps(page);
  await terminalPerf.reset();

  await page.keyboard.type(TYPED_LINE, { delay: KEY_DELAY_MS });
  await page.waitForTimeout(SETTLE_MS);
  await page.keyboard.press('Enter');
  await expectOutput(output, 'cursor-motion-ok');

  // The control. A session that never predicted would satisfy the assertion
  // below trivially — the drawn cursor would be authority's throughout, and
  // authority only moves forward while a line is being typed.
  const snapshot = await terminalPerf.snapshot();
  const predictions = collectPredictionDiagnostics(snapshot.events);
  expect(
    predictions.applied,
    'no prediction was applied, so this run proves nothing about the predicted cursor',
  ).toBeGreaterThan(0);

  expect(
    backwardsSteps,
    'the drawn cursor stepped backwards while typing; each line names the site that moved it',
  ).toEqual([]);
});

/**
 * The same line, submitted inside its own round trip.
 *
 * Enter is never modelled — predicting it would mark the keystroke
 * shadow-modelled and suppress the daemon's pre-emptive revocation — and it
 * used to flush the speculative line: every glyph whose echo was still on the
 * wire came off the screen, the row showed what authority had last drawn, and
 * the cursor stepped back to match, for one round trip. The daemon's grant
 * withdrawal on the same key then arrived as a header and did it again to
 * whatever the shell had not echoed yet. That is the "cursor jumps backwards
 * and I see past content" of 2026-09-07, and it needs no impaired network:
 * the last key and Enter go down back to back here, so the last echo is on
 * the wire when the line goes even on loopback. A submission now seals the
 * line — nothing typed behind it is modelled, nothing painted is taken back —
 * and the journal is the oracle, as above.
 */
test('submitting a line inside its round trip never steps the drawn cursor backwards', async ({
  page,
  linkedDaemon,
  terminalPerf,
}) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  await page.keyboard.type(
    `${BOLD_PROMPT_COMMAND}; ${PROMPT_TO_BOTTOM}; ${printReady('submit-prompt')}\n`,
  );
  await expectOutput(output, 'submit-prompt-ready');
  await page.waitForTimeout(SETTLE_MS);

  const backwardsSteps = collectBackwardsSteps(page);
  await terminalPerf.reset();

  await page.keyboard.type(TYPED_LINE.slice(0, -1), { delay: KEY_DELAY_MS });
  // No pause and no inter-key delay: the last glyph and the submission are
  // one burst, so that glyph's echo is still in flight when the line goes.
  await page.keyboard.type(`${TYPED_LINE.slice(-1)}\n`);
  await expectOutput(output, 'cursor-motion-ok');

  const snapshot = await terminalPerf.snapshot();
  const predictions = collectPredictionDiagnostics(snapshot.events);
  expect(
    predictions.applied,
    'no prediction was applied, so this run proves nothing about the predicted cursor',
  ).toBeGreaterThan(0);
  expect(
    backwardsSteps,
    'the drawn cursor stepped backwards around the submission; each line names the site that moved it',
  ).toEqual([]);
});

/**
 * The same question asked of fish, the shell this project's author runs.
 *
 * fish repaints the command line on every keystroke — syntax highlighting
 * recolours the tokens and an autosuggestion from history is drawn after the
 * cursor in dim text — so each echo is a redraw of the whole line rather than
 * the one character bash echoes. That is the shape of output under which the
 * cursor was reported to step backwards for a frame, so this test types a line
 * whose prefix matches a seeded history entry (the suggestion appears, then
 * diverges) and reads the same journal. It runs only where fish is installed;
 * the fixture pins the daemon's shell to bash and this `exec`s fish from that prompt with
 * no config, so nothing from the developer's own fish setup is under test.
 *
 * The prompt opens the shell-editor boundary exactly as the bash prompt above
 * does, unauthenticated. fish's own `printf` understands `\e` and `\a`.
 */
const FISH_BIN = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find((bin) =>
  existsSync(bin),
);
/**
 * The prompt the shipped `merkur shell-integration fish` snippet draws, with
 * the daemon's persisted token: fish runs here as a child of the harness bash
 * rather than as the spawned shell, so only the *authenticated* boundary
 * relaxes the foreground-process-group gate. Under tmux the sequences ride the
 * same DCS passthrough wrapper the snippet uses, or tmux swallows them.
 *
 * Written to a file through a quoted heredoc so the bytes fish reads are these
 * bytes: fish's single quotes turn `\\` into `\`, and `printf` then turns `\e`
 * into ESC and the remaining `\\` into the backslash of `ESC \` (ST).
 */
const FISH_PROMPT_FILE = String.raw`function fish_prompt
    printf '\e]133;A\a'
    set_color green
    printf 'e2e-fish> '
    set_color normal
    printf '\e]133;B;merkur=%s\a' $MERKUR_SHELL_TOKEN
end`;
const FISH_TMUX_PROMPT_FILE = String.raw`function fish_prompt
    printf '\ePtmux;\e\e]133;A\a\e\\\\'
    set_color green
    printf 'e2e-fish> '
    set_color normal
    printf '\ePtmux;\e\e]133;B;merkur=%s\a\e\\\\' $MERKUR_SHELL_TOKEN
end`;
const FISH_SEED_LINE = 'echo cursor-motion-fish-seed';
const FISH_TYPED_LINE = 'echo cursor-motion-fish-ok';

/**
 * Every worker display diagnostic reported from now on, in order: the cursor
 * journal lines the assertions read, and the resync, stage and apply
 * breadcrumbs that say what else the display was doing around them.
 */
function collectCursorDiagnostics(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    // Stamped on the same epoch clock as the perf events' `atMs`, so a journal
    // line can be placed against the keystrokes and frames around it.
    if (text.includes('terminal_display_diag')) lines.push(`${Date.now()} ${text}`);
  });
  return lines;
}

/**
 * The authoritative cursor's shape and visibility transitions, from the same
 * journal. A frame that hid the cursor is `visible:0`; a beam is `shape:2`.
 */
function summarizeCursorShapeChanges(diagnostics: readonly string[]) {
  let hidden = 0;
  let shown = 0;
  let beam = 0;
  let underline = 0;
  for (const line of diagnostics) {
    if (!line.includes(SHAPE_CHANGE_EVENT)) continue;
    const to = /to=shape:(\d+),visible:(\d+)/u.exec(line);
    if (to === null) continue;
    if (to[2] === '0') hidden += 1;
    else shown += 1;
    if (to[1] === '2') beam += 1;
    if (to[1] === '3') underline += 1;
  }
  return { hidden, shown, beam, underline };
}

const SHAPE_CHANGE_EVENT = 'cursor_shape_changed';

function countReasons(events: readonly unknown[]): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { kind?: unknown; reason?: unknown };
    if (record.kind === 'presentation_commit' && typeof record.reason === 'string') {
      reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
    }
  }
  return reasons;
}

function nativeRecords(native: DaemonPerfTraceCapture) {
  return native.chunks.flatMap((chunk) => chunk.records);
}

function writeCursorArtifacts(
  testInfo: TestInfo,
  name: string,
  summary: Readonly<Record<string, unknown>>,
  events: readonly unknown[],
  native: DaemonPerfTraceCapture,
): string {
  const artifactDir = testInfo.outputPath(name);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, 'summary.json'),
    JSON.stringify(
      {
        ...summary,
        nativeCaptureStatus: native.status,
        nativeRecords: nativeRecords(native).length,
        nativeErrors: native.errors,
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(artifactDir, 'events.json'), JSON.stringify(events));
  writeFileSync(path.join(artifactDir, 'native.json'), JSON.stringify(native));
  testInfo.annotations.push({ type: 'artifacts', description: artifactDir });
  return artifactDir;
}

/**
 * Wait for literal text in the worker's *current* grid, alternate screen
 * included. The accessibility mirror `expectOutput` polls is a log of committed
 * primary-screen output, which is exactly what tmux and Neovim never produce.
 */
async function expectViewport(page: Page, needle: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await page.evaluate(readDirectTuiViewportSnapshot)).text, { timeout })
    .toContain(needle);
}

/** Type a file into the harness shell through a quoted heredoc: no expansion. */
/**
 * Written straight into the daemon's disposable `$HOME` rather than typed
 * through the terminal: a thousand keystrokes at full speed is a burst the
 * measurement never asked for — one echo datagram per key saturated the delay
 * proxy's client-to-edge queue and the telemetry egress queue alike.
 */
function writeShellFile(daemonHome: string, name: string, body: string): void {
  writeFileSync(path.join(daemonHome, name), `${body}\n`);
}

type WaitForMarker = (marker: string) => Promise<void>;

/** Type fish's seed line and the measured line, returning the perf capture. */
async function typeFishLine(
  page: Page,
  waitFor: WaitForMarker,
  linkedDaemon: { capturePerfTrace(): Promise<DaemonPerfTraceCapture> },
  terminalPerf: { reset(): Promise<unknown>; snapshot(): Promise<{ events: readonly unknown[] }> },
) {
  // Seed history so the next line draws an autosuggestion from its first keys.
  await page.keyboard.type(`${FISH_SEED_LINE}\n`);
  await waitFor('cursor-motion-fish-seed');
  await page.waitForTimeout(SETTLE_MS);

  const diagnostics = collectCursorDiagnostics(page);
  await terminalPerf.reset();

  await page.keyboard.type(FISH_TYPED_LINE, { delay: KEY_DELAY_MS });
  await page.waitForTimeout(SETTLE_MS);
  const native = await linkedDaemon.capturePerfTrace();
  await page.keyboard.press('Enter');
  await waitFor('cursor-motion-fish-ok');
  const snapshot = await terminalPerf.snapshot();
  // Journal lines are stamped on the same epoch clock; the assertion reads
  // only those from the measured line. What tmux does to the cursor while it
  // restores the primary screen on teardown is not typing.
  const measuredUntilMs = Date.now();
  return { diagnostics, native, events: snapshot.events, measuredUntilMs };
}

/** Journal lines stamped inside the measured window. */
function diagnosticsUntil(diagnostics: readonly string[], untilMs: number): string[] {
  return diagnostics.filter((line) => {
    const stamp = Number(line.slice(0, line.indexOf(' ')));
    return Number.isFinite(stamp) && stamp <= untilMs;
  });
}

function assertFishLine(
  events: readonly unknown[],
  diagnostics: readonly string[],
  measuredUntilMs: number,
  context: string,
): void {
  const predictions = collectPredictionDiagnostics(events);
  expect(
    predictions.applied,
    `no prediction was applied ${context}, so this run proves nothing about the predicted cursor`,
  ).toBeGreaterThan(0);
  expect(
    diagnosticsUntil(diagnostics, measuredUntilMs).filter((line) =>
      line.includes(BACKWARDS_STEP_EVENT),
    ),
    `the drawn cursor stepped backwards while typing ${context}; each line names the site that moved it`,
  ).toEqual([]);
}

test('typing into fish with an autosuggestion never steps the drawn cursor backwards', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  test.skip(FISH_BIN === undefined, 'fish is not installed on this machine');
  const output = await primeTerminal(page, linkedDaemon.daemonName);

  writeShellFile(linkedDaemon.daemonHome, 'e2e-prompt.fish', FISH_PROMPT_FILE);
  // `exec`, so fish IS the spawned shell and owns the PTY's foreground process
  // group: the harness shell is restored with a second `exec` below, because
  // the daemon's shell outlives this test and the specs after it reset a bash
  // prompt. Started as a child instead, the same authenticated marker is
  // refused a grant — recorded as an open observation in PERF.md.
  await page.keyboard.type(
    `exec ${FISH_BIN} --no-config -C "source $HOME/e2e-prompt.fish; string repeat -n 60 \\n; ${printReady('fish-prompt')}"\n`,
  );
  await expectOutput(output, 'fish-prompt-ready');

  const { diagnostics, native, events, measuredUntilMs } = await typeFishLine(
    page,
    (marker) => expectOutput(output, marker),
    linkedDaemon,
    terminalPerf,
  );
  const predictions = collectPredictionDiagnostics(events);
  writeCursorArtifacts(
    testInfo,
    'cursor-fish',
    {
      fish: FISH_BIN,
      predictionsQueued: predictions.queued,
      predictionsApplied: predictions.applied,
      commitReasons: countReasons(events),
      cursorShapeChanges: summarizeCursorShapeChanges(diagnostics),
      cursorDiagnostics: diagnostics,
    },
    events,
    native,
  );
  await page.keyboard.type('exec /bin/bash\n');
  await page.keyboard.type(`${printReady('fish-closed')}\n`);
  await expectOutput(output, 'fish-closed-ready');

  assertFishLine(events, diagnostics, measuredUntilMs, 'into fish');
});

/**
 * The stack the reporter actually types into: tmux between the daemon's shell
 * and fish. tmux is its own terminal emulator — it re-renders the pane into
 * the outer PTY in its own writes, hides the cursor while it does, and only
 * frames a redraw with synchronized output when it believes the outer terminal
 * supports it — so what reaches the daemon is tmux's output shape, not fish's.
 * `-f /dev/null` keeps the developer's tmux configuration out of it, and
 * `allow-passthrough` is set the way the shipped shell integration sets it.
 * The feature list tmux negotiated with the daemon's terminal is recorded so a
 * result can be read against it.
 */
const TMUX_BIN = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((bin) =>
  existsSync(bin),
);

interface TmuxSession {
  readonly socket: string;
  readonly features: string;
}

/**
 * tmux 3.6b frames nothing a pane writes: it never answers `DECRQM 2026`,
 * ignores the mode when a pane sets it, and its own `sync` terminal feature
 * (granted by identity to iTerm2 alone) wraps only overlays and cursor-mode
 * changes. The features the client negotiated are recorded in the artifact so
 * a run on a tmux that does frame is recognisable.
 */
async function startTmux(page: Page, label: string): Promise<TmuxSession> {
  const socket = `merkur-e2e-${process.pid}-${label}`;
  // The daemon exports exactly this TERM to the shell it spawns.
  const term = 'TERM=xterm-256color';
  await page.keyboard.type(
    `${term} ${TMUX_BIN} -u -f /dev/null -L ${socket} new-session -d && ${term} ${TMUX_BIN} -u -L ${socket} attach\n`,
  );
  // The format string is split so the typed command's own echo cannot match
  // the row the output produces.
  // Passthrough as the shipped integration sets it. The status line is off:
  // its clock is redrawn every `status-interval` as a framed update of its
  // own, which is a second image for whichever keystroke it lands on and
  // nothing to do with that keystroke's redraw.
  await page.keyboard.type(
    `${TMUX_BIN} -L ${socket} set -g allow-passthrough on; ${TMUX_BIN} -L ${socket} set -g status off; printf 'TMUX%s=%s;\\n' FEATURES "$(${TMUX_BIN} -L ${socket} display -p '#{client_termfeatures}')"\n`,
  );
  await expectViewport(page, 'TMUXFEATURES=');
  const text = (await page.evaluate(readDirectTuiViewportSnapshot)).text;
  const features = /TMUXFEATURES=([^;\n]*);/u.exec(text)?.[1] ?? '';
  return { socket, features };
}

/**
 * Kill the session's server from the runner. Typing `exit` would depend on
 * every step before it having succeeded, and it races this kill: an `exit`
 * still in flight when the server dies lands in the daemon's own shell, which
 * exits, the dataplane respawns a default-sized PTY, and the browser re-issues
 * the session — a spurious resize that showed up only under seeded loss, where
 * the keystroke takes long enough to lose the race. So nothing is typed into
 * tmux on the way out; the kill ends everything inside it.
 */
function killTmux(session: TmuxSession): void {
  if (TMUX_BIN === undefined) return;
  spawnSync(TMUX_BIN, ['-L', session.socket, 'kill-server'], {
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  });
}

async function stopTmux(page: Page, session: TmuxSession): Promise<void> {
  killTmux(session);
  await page.keyboard.type("printf 'TMUX%s\\n' CLOSED\n");
  await expectViewport(page, 'TMUXCLOSED');
}

test('typing into fish under tmux never steps the drawn cursor backwards', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  test.skip(FISH_BIN === undefined, 'fish is not installed on this machine');
  test.skip(TMUX_BIN === undefined, 'tmux is not installed on this machine');
  await primeTerminal(page, linkedDaemon.daemonName);
  writeShellFile(linkedDaemon.daemonHome, 'e2e-prompt-tmux.fish', FISH_TMUX_PROMPT_FILE);
  const tmux = await startTmux(page, 'fish');
  try {
    await page.keyboard.type(
      `${FISH_BIN} --no-config -C "source $HOME/e2e-prompt-tmux.fish; ${printReady('fish-prompt')}"\n`,
    );
    await expectViewport(page, 'fish-prompt-ready');

    const { diagnostics, native, events, measuredUntilMs } = await typeFishLine(
      page,
      (marker) => expectViewport(page, marker),
      linkedDaemon,
      terminalPerf,
    );
    const predictions = collectPredictionDiagnostics(events);
    const census = summarizeTuiRedrawCensus(events, nativeRecords(native));
    writeCursorArtifacts(
      testInfo,
      'cursor-fish-tmux',
      {
        fish: FISH_BIN,
        tmux: TMUX_BIN,
        tmuxFeatures: tmux.features,
        predictionsQueued: predictions.queued,
        predictionsApplied: predictions.applied,
        commitReasons: countReasons(events),
        cursorShapeChanges: summarizeCursorShapeChanges(diagnostics),
        census,
        cursorDiagnostics: diagnostics,
      },
      events,
      native,
    );
    await stopTmux(page, tmux);
    assertFishLine(events, diagnostics, measuredUntilMs, 'into fish under tmux');
  } finally {
    killTmux(tmux);
  }
});

/**
 * Moving the cursor in Neovim under tmux, which the reporter described as the
 * screen flickering and jumping.
 *
 * Each `j` with `relativenumber` and `cursorline` on rewrites every line
 * number, two line backgrounds and the status line: a redraw of most of the
 * screen per keystroke. Neovim frames it with synchronized output when the
 * terminal admits to supporting it, and tmux re-frames it for the outer PTY
 * only when it negotiated the same — so this is exactly the workload under
 * which an unframed redraw reaches the daemon as several PTY reads, each
 * flushed and each painted. The census counts how many images the browser
 * showed per keystroke; one is the answer the reporter expects.
 */
const NVIM_BIN = (() => {
  try {
    return (
      execFileSync('/bin/sh', ['-lc', 'command -v nvim'], { encoding: 'utf8' }).trim() || undefined
    );
  } catch {
    return undefined;
  }
})();
const SEEDED_LOSS_PERCENT = Number(process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT ?? '0') || 0;
const NVIM_STEPS = 30;
const NVIM_KEY_DELAY_MS = 90;

/**
 * Neovim writes twice per cursor move: `showcmd`'s pending key plus the cursor
 * move, then the redraw 0.3–0.8 ms later. Under tmux nothing frames the pair,
 * so the daemon sees two PTY reads and the browser folds them at its animation
 * frame; a frame boundary inside the gap shows the pair as two images, which
 * is Neovim's declared sequence and not a tear. The oracle is therefore exact
 * rather than a count of images: no keystroke paints more images than the PTY
 * reads its output arrived in, and no sender group is split. That needs the
 * daemon's native trace, which only exists when the capture flag was set
 * before the daemon launched.
 */
const NATIVE_CAPTURE_ENABLED = process.env.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE === '1';

test('moving the cursor in neovim under tmux never paints a PTY read as two images', async ({
  page,
  linkedDaemon,
  terminalPerf,
}, testInfo) => {
  test.skip(NVIM_BIN === undefined, 'neovim is not installed on this machine');
  test.skip(TMUX_BIN === undefined, 'tmux is not installed on this machine');
  test.skip(
    !NATIVE_CAPTURE_ENABLED,
    'the per-read oracle needs MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1 before the daemon launches',
  );
  const output = await primeTerminal(page, linkedDaemon.daemonName);

  await page.keyboard.type(
    `for i in $(seq 1 400); do printf 'line %03d lorem ipsum dolor sit amet consectetur\\n' "$i"; done > "$HOME/merkur-e2e.txt"; ${printReady('file')}\n`,
  );
  await expectOutput(output, 'file-ready');
  const tmux = await startTmux(page, 'nvim');
  try {
    await page.keyboard.type(
      `${NVIM_BIN} --clean -c 'set number relativenumber cursorline laststatus=2' -c 'normal! 10G' "$HOME/merkur-e2e.txt"\n`,
    );
    await expectViewport(page, 'line 010 lorem');
    await page.waitForTimeout(SETTLE_MS);

    const diagnostics = collectCursorDiagnostics(page);
    await terminalPerf.reset();
    await page.keyboard.type('j'.repeat(NVIM_STEPS), { delay: NVIM_KEY_DELAY_MS });
    await page.keyboard.type('k'.repeat(NVIM_STEPS), { delay: NVIM_KEY_DELAY_MS });
    await page.waitForTimeout(SETTLE_MS);
    const native = await linkedDaemon.capturePerfTrace();
    const snapshot = await terminalPerf.snapshot();
    const finalViewport = (await page.evaluate(readDirectTuiViewportSnapshot)).text;

    const census = summarizeTuiRedrawCensus(snapshot.events, nativeRecords(native));
    const shapes = summarizeCursorShapeChanges(diagnostics);
    writeCursorArtifacts(
      testInfo,
      'cursor-nvim-tmux',
      {
        nvim: NVIM_BIN,
        tmux: TMUX_BIN,
        tmuxFeatures: tmux.features,
        steps: NVIM_STEPS * 2,
        keyDelayMs: NVIM_KEY_DELAY_MS,
        commitReasons: countReasons(snapshot.events),
        cursorShapeChanges: shapes,
        census: { ...census, perKeystroke: undefined },
        perKeystroke: census.perKeystroke,
        finalViewport,
        cursorDiagnostics: diagnostics,
      },
      snapshot.events,
      native,
    );

    // Neovim keeps reading keys until it has actually exited, so the marker
    // is typed only once its screen is gone.
    await page.keyboard.type(':q!\n');
    await expect
      .poll(async () => (await page.evaluate(readDirectTuiViewportSnapshot)).text)
      .not.toContain('lorem ipsum');
    await page.keyboard.type("printf 'NVIM%s\\n' CLOSED\n");
    await expectViewport(page, 'NVIMCLOSED');
    await stopTmux(page, tmux);

    expect(native.status, native.errors.join('; ')).toBe('complete');
    expect(census.keystrokes, 'every step must be attributable to a keystroke').toBe(
      NVIM_STEPS * 2,
    );
    expect(census.nativeUnjoined, 'every keystroke must join the native trace').toBe(0);
    expect(shapes.hidden, 'a frame hid the cursor mid-redraw').toBe(0);
    // Seeded datagram loss tears a redraw by design — a member arrives after
    // the deadline release — so the exact bound is a clean-path oracle; under
    // loss the census artifact is the result.
    if (SEEDED_LOSS_PERCENT === 0) {
      expect(
        census.totals.keystrokesWithMoreCommitsThanReads,
        `${census.totals.keystrokesWithMoreCommitsThanReads} of ${census.keystrokes} steps were painted in more images than PTY reads; see the census artifact`,
      ).toBe(0);
      expect(census.totals.splitGroups, 'a sender group was painted across two images').toBe(0);
    }
  } finally {
    killTmux(tmux);
  }
});
