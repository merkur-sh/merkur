import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import { linkTestExecutable } from '../../../scripts/test-executables';
import { runTestProcess } from '../../../scripts/test-process';

import {
  beginDirectTuiActivationObservation,
  buildNeovimNavigationWorkload,
  buildTmuxSwitchWorkload,
  cleanupDirectTuiWorkload,
  type DirectTuiToolEvidence,
  findDirectTuiActivationFence,
  matchDirectTuiViewport,
  readDirectTuiViewportSnapshot,
  summarizeDirectCoherentInputWindows,
  validateDirectTuiActivationMeasurementBoundary,
  waitForDirectTuiViewportMarker,
} from './direct-tui-workloads';

describe('Direct TUI workload commands', () => {
  test('resets a full prior observation after readiness and before activation', async () => {
    const calls: string[] = [];
    let retainedEventCount = 20_400;
    let droppedEventCount = 562;
    const activatedAtMs = await beginDirectTuiActivationObservation({
      waitForReady: async () => {
        calls.push('ready');
      },
      resetObservation: async () => {
        calls.push('reset');
        retainedEventCount = 0;
        droppedEventCount = 0;
      },
      now: async () => {
        calls.push('timestamp');
        expect(retainedEventCount).toBe(0);
        expect(droppedEventCount).toBe(0);
        return 123;
      },
      activate: async () => {
        calls.push('activate');
        retainedEventCount += 4;
      },
    });

    expect(activatedAtMs).toBe(123);
    expect(calls).toEqual(['ready', 'reset', 'timestamp', 'activate']);
    expect(retainedEventCount).toBe(4);
    expect(droppedEventCount).toBe(0);
  });

  test('requires the exact activation measurement boundary in the calibrated lineage', () => {
    const expected = {
      measurementId: 41,
      activatedAtMs: 100,
      proofCutAtMs: 140,
      sessionEpoch: 7,
    } as const;
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(101, 41, 'start'), ringBoundary(130, 41, 'end')],
        expected,
      ),
    ).toEqual([]);
    expect(validateDirectTuiActivationMeasurementBoundary([], expected)).toEqual([
      'Direct TUI activation proof has 0 ring boundaries, 0 for measurement 41',
      'Direct TUI activation measurement 41 has 0 START and 0 END boundaries',
    ]);
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(101, 40, 'start'), ringBoundary(130, 40, 'end')],
        expected,
      ),
    ).toContain('Direct TUI activation proof has 2 ring boundaries, 0 for measurement 41');
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(101, 41, 'start'), ringBoundary(130, 41, 'end', 8)],
        expected,
      ),
    ).toContain('Direct TUI activation ring boundaries do not share the calibrated lineage');
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(99, 41, 'start'), ringBoundary(141, 41, 'end')],
        expected,
      ),
    ).toContain('Direct TUI activation ring boundary is outside the activation proof interval');
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(101, 41, 'start'), ringBoundary(101, 41, 'end')],
        expected,
      ),
    ).toContain('Direct TUI activation ring boundary is outside the activation proof interval');
    expect(
      validateDirectTuiActivationMeasurementBoundary(
        [ringBoundary(101, 41, 'start', 7, 0xffff_ffff), ringBoundary(130, 41, 'end', 7, 1)],
        expected,
      ),
    ).toContain('Direct TUI activation receive ring refused 2 frames');
  });

  test('builds two full-screen tmux panes with one-byte switching and explicit cleanup', async () => {
    const plan = buildTmuxSwitchWorkload(tool('tmux'), 'abc123');
    expect(plan).toMatchObject({
      application: 'tmux',
      readyMarker: 'direct-tmux-ready-abc123',
      exitMarker: 'direct-tmux-exit-abc123',
      stepKeys: ['Control+n'],
      operationCycleLength: 2,
      exitKeys: ['Control+x'],
    });
    expect(plan.launchCommand).toContain('bind-key -n C-n next-window');
    expect(plan.launchCommand).toContain('bind-key -n C-x detach-client');
    expect(plan.launchCommand).toContain('TMUX=');
    expect(plan.launchCommand).toContain('-f /dev/null');
    expect(plan.launchCommand).toContain('status off');
    expect(plan.launchCommand).toContain('MERKUR-TMUX-A-abc123');
    expect(plan.launchCommand).toContain('MERKUR-TMUX-B-abc123');
    expect(plan.initialViewportNeedle).toContain('ALPHA-02-');
    expect(plan.launchCommand).not.toContain(plan.initialViewportNeedle);
    expect(plan.completedCycleViewportNeedle).toBe(plan.initialViewportNeedle);
    expect(plan.launchCommand).toContain('kill-server');
    expect(plan.launchCommand.endsWith('\n')).toBe(true);
    const syntax = await runTestProcess(['/bin/sh', '-n', '-c', plan.launchCommand]);
    expect(syntax.exitCode, syntax.stderr).toBe(0);
  });

  test('cleans only the plan-owned tmux socket and Neovim fixture after preactivation failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merkur-direct-tui-cleanup-'));
    try {
      const invocation = join(directory, 'tmux-args.txt');
      // One file under four names: macOS assesses each new executable file once, and a declared
      // test starts with an empty store. `$0` is the link in this directory, so the stub
      // answers by its name and records beside it.
      const stub = [
        '#!/bin/sh',
        `case "\${0##*/}" in`,
        `  tmux) printf '%s\\n' "$@" > "\${0%/*}/tmux-args.txt" ;;`,
        "  tmux-absent) printf 'no server running on /private/tmp/tmux-501/merkur-direct-cleanup123\\n' >&2; exit 1 ;;",
        "  tmux-wrong-absent) printf 'no server running on /private/tmp/tmux-501/merkur-direct-someone-else\\n' >&2; exit 1 ;;",
        "  tmux-generic-failure) printf 'failed to connect: Connection refused (No such file or directory)\\n' >&2; exit 2 ;;",
        'esac',
        '',
      ].join('\n');
      const fakeTmux = linkTestExecutable(directory, 'tmux', stub);
      const tmuxPlan = buildTmuxSwitchWorkload({ ...tool('tmux'), path: fakeTmux }, 'cleanup123');
      const tmuxCleanup = tmuxPlan.cleanup;
      if (tmuxCleanup.kind !== 'tmux-server') throw new Error('expected tmux cleanup');
      await cleanupDirectTuiWorkload(tmuxPlan);
      expect(readFileSync(invocation, 'utf8')).toBe('-L\nmerkur-direct-cleanup123\nkill-server\n');

      const absentTmux = linkTestExecutable(directory, 'tmux-absent', stub);
      await cleanupDirectTuiWorkload({
        ...tmuxPlan,
        cleanup: { ...tmuxCleanup, executablePath: absentTmux },
      });

      const wrongAbsentTmux = linkTestExecutable(directory, 'tmux-wrong-absent', stub);
      await expect(
        cleanupDirectTuiWorkload({
          ...tmuxPlan,
          cleanup: { ...tmuxCleanup, executablePath: wrongAbsentTmux },
        }),
      ).rejects.toThrow(/exact tmux cleanup exited 1/);

      const genericFailureTmux = linkTestExecutable(directory, 'tmux-generic-failure', stub);
      await expect(
        cleanupDirectTuiWorkload({
          ...tmuxPlan,
          cleanup: { ...tmuxCleanup, executablePath: genericFailureTmux },
        }),
      ).rejects.toThrow(/exact tmux cleanup exited 2/);

      const nvimPlan = buildNeovimNavigationWorkload(tool('nvim'), 'cleanup456');
      if (nvimPlan.cleanup.kind !== 'fixture-file') throw new Error('expected fixture cleanup');
      writeFileSync(nvimPlan.cleanup.path, 'temporary fixture');
      await cleanupDirectTuiWorkload(nvimPlan);
      expect(existsSync(nvimPlan.cleanup.path)).toBe(false);
      await expect(
        cleanupDirectTuiWorkload({
          ...nvimPlan,
          cleanup: { kind: 'fixture-file', path: '/tmp/not-a-merkur-benchmark-file' },
        }),
      ).rejects.toThrow(/refusing/);
      await expect(
        cleanupDirectTuiWorkload({
          ...tmuxPlan,
          cleanup: {
            kind: 'tmux-server',
            executablePath: fakeTmux,
            socketName: 'default',
          },
        }),
      ).rejects.toThrow(/refusing/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
      rmSync('/tmp/merkur-direct-nvim-cleanup456.rs', { force: true });
    }
  });

  test('builds a deterministic highlighted Neovim buffer with alternating one-byte navigation', async () => {
    const plan = buildNeovimNavigationWorkload(tool('nvim'), 'def456');
    expect(plan).toMatchObject({
      application: 'neovim',
      readyMarker: 'direct-nvim-ready-def456',
      exitMarker: 'direct-nvim-exit-def456',
      stepKeys: ['Control+f', 'Control+b'],
      operationCycleLength: 2,
      exitKeys: ['Escape', ':q!', 'Enter'],
    });
    expect(plan.launchCommand).toContain('merkur-direct-nvim-def456.rs');
    expect(plan.launchCommand).toContain('2400');
    expect(plan.launchCommand).toContain('filetype=rust | syntax enable | normal! gg');
    expect(plan.initialViewportNeedle).toBe('pub fn merkur_line_0001()');
    expect(plan.launchCommand).not.toContain(plan.initialViewportNeedle);
    expect(plan.completedCycleViewportNeedle).toBe(plan.initialViewportNeedle);
    expect(plan.launchCommand).toContain('rm -f');
    expect(plan.launchCommand.endsWith('\n')).toBe(true);
    const syntax = await runTestProcess(['/bin/sh', '-n', '-c', plan.launchCommand]);
    expect(syntax.exitCode, syntax.stderr).toBe(0);
  });

  test('rejects tokens or capability evidence that could alter the shell command', () => {
    expect(() => buildTmuxSwitchWorkload(tool('tmux'), "bad'token")).toThrow(/token/);
    expect(() => buildNeovimNavigationWorkload(tool('tmux'), 'valid')).toThrow(/nvim/);
    expect(() =>
      buildTmuxSwitchWorkload({ ...tool('tmux'), sha256: 'not-a-digest' }, 'valid'),
    ).toThrow(/capability/);
    expect(() =>
      buildTmuxSwitchWorkload({ ...tool('tmux'), sha256: 'g'.repeat(64) }, 'valid'),
    ).toThrow(/capability/);
    expect(() =>
      buildTmuxSwitchWorkload({ ...tool('tmux'), application: 'neovim' }, 'valid'),
    ).toThrow(/capability/);
  });
});

describe('Direct TUI activation fence', () => {
  test('joins an authoritative apply through its exact transaction and render fence', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toEqual({
      generation: 7,
      latestApplyDisplaySeqs: [31],
      displaySeq: 31,
      presentationTransactionSeq: 10,
      renderSeq: 90,
      applyAtMs: 100,
      commitAtMs: 101,
      fenceAtMs: 102,
      viewportRequestedAtMs: 103,
      viewportCompletedAtMs: 104,
      proofCutAtMs: 104.5,
      proofCapturedAtMs: 105,
    });
  });

  test('does not pair unrelated or pre-commit GPU liveness with an apply', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 11, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(105, 90),
        ],
        proofBounds(99, 104, 105, 105.5, 106),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          frameComplete(100.5, 90),
          commit(101, 7, 10, 90),
          renderStart(100.25, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 91),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
          applied(103, 7, 32, 11),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
  });

  test('requires an authoritative apply that races during the viewport request to be fenced', () => {
    const requestedAtMs = 102.5;
    const completedAtMs = 104;
    expect(requestedAtMs).toBeLessThan(completedAtMs);
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
          applied(103, 7, 32, 11),
        ],
        proofBounds(99, requestedAtMs, completedAtMs, 104.5, 105),
      ),
    ).toBeNull();
  });

  test('cannot hide a later visual apply that lacks presentation ownership', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
          applied(103, 7, 32, 0),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
  });

  test('rejects a visual apply after the viewport reply but before the proof snapshot', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
          applied(104.5, 7, 32, 11),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
  });

  test('fails closed at query boundaries and on impossible capture lineage', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(103, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          commit(101, 7, 10, 90),
          renderStart(100.5, 90),
          frameComplete(102, 90),
          applied(103, 7, 32, 11),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(() =>
      findDirectTuiActivationFence(
        [applied(106, 7, 31, 10)],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toThrow(/after its capture/);
    expect(() => findDirectTuiActivationFence([], proofBounds(99, 103, 104, 103.5, 105))).toThrow(
      /timestamps/,
    );
  });

  test('rejects a later render or session change even when the grid emits no apply', () => {
    const base = [
      applied(100, 7, 31, 10),
      commit(101, 7, 10, 90),
      renderStart(100.5, 90),
      frameComplete(102, 90),
    ] satisfies TerminalPerfEvent[];
    expect(
      findDirectTuiActivationFence(
        [...base, renderStart(104, 91)],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [...base, sessionStart(104)],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
    expect(
      findDirectTuiActivationFence(
        [...base, sessionStart(99)],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toBeNull();
  });

  test('joins equal-time members only through their one exact positive transaction', () => {
    expect(
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          applied(100, 7, 32, 10),
          renderStart(100.5, 90),
          commit(101, 7, 10, 90),
          frameComplete(102, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toMatchObject({
      generation: 7,
      latestApplyDisplaySeqs: [31, 32],
      displaySeq: 32,
      presentationTransactionSeq: 10,
      renderSeq: 90,
    });
    expect(() =>
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          applied(100, 7, 32, 11),
          renderStart(100.5, 90),
          commit(101, 7, 10, 90),
          frameComplete(102, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toThrow(/transaction-ambiguous/);
    expect(() =>
      findDirectTuiActivationFence(
        [
          applied(100, 7, 31, 10),
          applied(100, 8, 32, 10),
          renderStart(100.5, 90),
          commit(101, 7, 10, 90),
          frameComplete(102, 90),
        ],
        proofBounds(99, 103, 104, 104.5, 105),
      ),
    ).toThrow(/transaction-ambiguous/);
  });
});

describe('Direct TUI worker viewport oracle', () => {
  test('reads exact current-grid text through the profiling hook', async () => {
    const scope = globalThis as typeof globalThis & {
      __merkurTerminalPerfReadViewportText?: () => Promise<unknown>;
    };
    const previous = scope.__merkurTerminalPerfReadViewportText;
    try {
      scope.__merkurTerminalPerfReadViewportText = async () => 'first\nTARGET row\nlast';
      const snapshot = await readDirectTuiViewportSnapshot();
      expect(snapshot.completedAtMs).toBeGreaterThanOrEqual(snapshot.requestedAtMs);
      expect(matchDirectTuiViewport(snapshot.text, 'TARGET')).toEqual({
        rowIndex: 1,
        rowText: 'TARGET row',
      });
    } finally {
      scope.__merkurTerminalPerfReadViewportText = previous;
    }
  });

  test('fails closed on a missing/malformed hook or absent current row', async () => {
    const scope = globalThis as typeof globalThis & {
      __merkurTerminalPerfReadViewportText?: () => Promise<unknown>;
    };
    const previous = scope.__merkurTerminalPerfReadViewportText;
    try {
      scope.__merkurTerminalPerfReadViewportText = undefined;
      await expect(readDirectTuiViewportSnapshot()).rejects.toThrow(/unavailable/);
      scope.__merkurTerminalPerfReadViewportText = async () => 1;
      await expect(readDirectTuiViewportSnapshot()).rejects.toThrow(/malformed/);
      expect(() => matchDirectTuiViewport('one\ntwo', 'TARGET')).toThrow(/does not contain/);
    } finally {
      scope.__merkurTerminalPerfReadViewportText = previous;
    }
  });

  test('finds an exact marker row after command echo and delayed delivery', async () => {
    const marker = 'direct-quiet-abc123';
    const snapshots = [
      viewportSnapshot(`printf '%s\\n' '${marker}'`, 100, 100.1),
      viewportSnapshot(`printf '%s\\n' '${marker}'`, 125.1, 125.2),
      viewportSnapshot(`printf '%s\\n' '${marker}'\n${marker}   `, 150.2, 150.3),
    ];
    let reads = 0;
    let identityChecks = 0;
    const waits: number[] = [];
    const evidence = await waitForDirectTuiViewportMarker(marker, {
      read: async () => {
        const snapshot = snapshots[reads] ?? snapshots[snapshots.length - 1];
        reads += 1;
        if (snapshot === undefined) throw new Error('test viewport population is empty');
        return snapshot;
      },
      assertReaderIdentity: async () => {
        identityChecks += 1;
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      timeoutMs: 5_000,
      pollIntervalMs: 25,
    });
    expect(evidence.attempts).toBe(3);
    expect(evidence.match).toEqual({ rowIndex: 1, rowText: `${marker}   ` });
    expect(identityChecks).toBe(6);
    expect(waits).toEqual([25, 25]);
  });

  test('retains the final raw grid when the shared marker deadline expires', async () => {
    const snapshots = [
      viewportSnapshot('old-grid', 100, 100.1),
      viewportSnapshot('still-old', 125.1, 125.2),
      viewportSnapshot('last-raw-grid', 150.2, 150.3),
    ];
    let reads = 0;
    await expect(
      waitForDirectTuiViewportMarker('TARGET', {
        read: async () => {
          const snapshot = snapshots[reads] ?? snapshots[snapshots.length - 1];
          reads += 1;
          if (snapshot === undefined) throw new Error('test viewport population is empty');
          return snapshot;
        },
        assertReaderIdentity: async () => undefined,
        wait: async () => undefined,
        timeoutMs: 50,
        pollIntervalMs: 25,
      }),
    ).rejects.toThrow(/last-raw-grid/);
    expect(reads).toBe(3);
  });

  test('rejects matching marker content returned after the shared deadline', async () => {
    const marker = 'TARGET';
    const snapshots = [
      viewportSnapshot('old-grid', 100, 100.1),
      viewportSnapshot(marker, 149.9, 150.1),
    ];
    let reads = 0;
    await expect(
      waitForDirectTuiViewportMarker(marker, {
        read: async () => {
          const snapshot = snapshots[reads] ?? snapshots[snapshots.length - 1];
          reads += 1;
          if (snapshot === undefined) throw new Error('test viewport population is empty');
          return snapshot;
        },
        assertReaderIdentity: async () => undefined,
        wait: async () => undefined,
        timeoutMs: 50,
        pollIntervalMs: 25,
      }),
    ).rejects.toThrow(/shared deadline/);
    expect(reads).toBe(2);
  });

  test('fails if the calibrated worker reader changes around a retry', async () => {
    let identityChecks = 0;
    await expect(
      waitForDirectTuiViewportMarker('TARGET', {
        read: async () => viewportSnapshot('old-grid', 100, 100.1),
        assertReaderIdentity: async () => {
          identityChecks += 1;
          if (identityChecks === 2) throw new Error('reader identity replaced');
        },
        wait: async () => undefined,
        timeoutMs: 50,
        pollIntervalMs: 25,
      }),
    ).rejects.toThrow(/reader identity replaced/);
    expect(identityChecks).toBe(2);
  });
});

describe('Direct TUI input populations', () => {
  test('reconstructs exactly one distinct one-byte input in every coherent window', () => {
    const summary = summarizeDirectCoherentInputWindows(
      [
        boundary(9, 'end', 22),
        input(42, 11),
        boundary(7, 'start', 10),
        input(43, 21),
        boundary(7, 'end', 12),
        boundary(9, 'start', 20),
      ],
      2,
    );
    expect(summary).toEqual({
      windowCount: 2,
      inputCount: 2,
      inputBytesPerWindow: 1,
      windows: [
        { measurementId: 7, startAtMs: 10, endAtMs: 12, inputSeq: 42 },
        { measurementId: 9, startAtMs: 20, endAtMs: 22, inputSeq: 43 },
      ],
    });
  });

  test('rejects missing, duplicate, inverted, or overlapping window boundaries', () => {
    expect(() =>
      summarizeDirectCoherentInputWindows([boundary(1, 'start', 10), input(1, 11)], 1),
    ).toThrow(/boundaries/);
    expect(() =>
      summarizeDirectCoherentInputWindows(
        [boundary(1, 'start', 10), boundary(1, 'start', 10.5), boundary(1, 'end', 12)],
        1,
      ),
    ).toThrow(/duplicate START/);
    expect(() =>
      summarizeDirectCoherentInputWindows(
        [boundary(1, 'start', 12), boundary(1, 'end', 10), input(1, 11)],
        1,
      ),
    ).toThrow(/incomplete or inverted/);
    expect(() =>
      summarizeDirectCoherentInputWindows(
        [
          boundary(1, 'start', 10),
          input(1, 11),
          boundary(2, 'start', 11.5),
          boundary(1, 'end', 12),
          input(2, 12.5),
          boundary(2, 'end', 13),
        ],
        2,
      ),
    ).toThrow(/overlap/);
  });

  test('rejects missing, extra, duplicate, out-of-window, or non-byte inputs', () => {
    const oneWindow = [boundary(1, 'start', 10), boundary(1, 'end', 12)] as const;
    expect(() => summarizeDirectCoherentInputWindows(oneWindow, 1)).toThrow(/0 inputs/);
    expect(() =>
      summarizeDirectCoherentInputWindows([...oneWindow, input(1, 10.5), input(2, 11)], 1),
    ).toThrow(/2 inputs/);
    expect(() =>
      summarizeDirectCoherentInputWindows(
        [
          ...oneWindow,
          boundary(2, 'start', 20),
          boundary(2, 'end', 22),
          input(1, 11),
          input(1, 21),
        ],
        2,
      ),
    ).toThrow(/duplicated/);
    expect(() => summarizeDirectCoherentInputWindows([...oneWindow, input(1, 15)], 1)).toThrow(
      /owns 0 inputs/,
    );
    expect(() => summarizeDirectCoherentInputWindows([...oneWindow, input(1, 11, 2)], 1)).toThrow(
      /not one valid admitted byte/,
    );
  });

  test('requires contiguous nonzero u32 input ownership, including wrap', () => {
    const twoWindows = [
      boundary(1, 'start', 10),
      input(0xffff_ffff, 11),
      boundary(1, 'end', 12),
      boundary(2, 'start', 20),
      input(1, 21),
      boundary(2, 'end', 22),
    ];
    expect(summarizeDirectCoherentInputWindows(twoWindows, 2).inputCount).toBe(2);
    expect(() =>
      summarizeDirectCoherentInputWindows(
        twoWindows.map((event) =>
          event.kind === 'input_queued' && event.inputSeq === 1 ? { ...event, inputSeq: 2 } : event,
        ),
        2,
      ),
    ).toThrow(/not contiguous/);
  });
});

function tool(binaryName: 'tmux' | 'nvim'): DirectTuiToolEvidence {
  return {
    application: binaryName === 'tmux' ? 'tmux' : 'neovim',
    binaryName,
    path: `/opt/tools with spaces/${binaryName}`,
    version: `${binaryName} test`,
    hashScope: 'executable-file-only',
    sha256: 'a'.repeat(64),
  };
}

function ringBoundary(
  atMs: number,
  measurementId: number,
  phase: 'start' | 'end',
  sessionEpoch = 7,
  ringDroppedTotal = 0,
): Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }> {
  return {
    kind: 'display_ring_measurement_boundary',
    atMs,
    measurementId,
    phase,
    observationEpoch: 3,
    sessionEpoch,
    ringDroppedTotal,
  };
}

function boundary(
  measurementId: number,
  phase: 'start' | 'end',
  atMs: number,
): Extract<TerminalPerfEvent, { kind: 'presentation_measurement_boundary' }> {
  return {
    kind: 'presentation_measurement_boundary',
    atMs,
    measurementId,
    phase,
    purpose: 'coherent-redraw',
  };
}

function input(
  inputSeq: number,
  atMs: number,
  byteLength = 1,
): Extract<TerminalPerfEvent, { kind: 'input_queued' }> {
  return {
    kind: 'input_queued',
    atMs,
    admittedAtMs: atMs + 0.01,
    inputSeq,
    byteLength,
  };
}

function proofBounds(
  activatedAtMs: number,
  viewportRequestedAtMs: number,
  viewportCompletedAtMs: number,
  proofCutAtMs: number,
  proofCapturedAtMs: number,
) {
  return {
    activatedAtMs,
    viewportRequestedAtMs,
    viewportCompletedAtMs,
    proofCutAtMs,
    proofCapturedAtMs,
  };
}

function viewportSnapshot(text: string, requestedAtMs: number, completedAtMs: number) {
  return { text, requestedAtMs, completedAtMs };
}

function applied(
  atMs: number,
  generation: number,
  displaySeq: number,
  presentationTransactionSeq: number,
): Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }> {
  return {
    kind: 'worker_display_applied',
    atMs,
    displaySeq,
    generation,
    inputSeq: 1,
    frameId: displaySeq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 3,
    presentationMemberIndex: 0,
    presentationMemberCount: 1,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq,
    presentationCoherent: true,
    presentationEnd: true,
    fecRecovered: false,
    authoritativeVisualMutation: true,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: 0.1,
    byteLength: 100,
    rowCount: 1,
    displayKind: 'display_delta',
  };
}

function commit(
  atMs: number,
  generation: number,
  transactionSeq: number,
  renderSeq: number,
): Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> {
  return {
    kind: 'presentation_commit',
    atMs,
    releaseFrameTimeMs: 0,
    releaseFrameCount: 0,
    membershipReleaseDisableBits: 0,
    transactionSeq,
    renderSeq,
    generation,
    firstDisplaySeq: 31,
    lastDisplaySeq: 31,
    displayInputSeq: 1,
    displayEchoHorizonSeq: 1,
    firstPresentationId: 3,
    lastPresentationId: 3,
    firstApplyToCommitMs: 1,
    lastApplyToCommitMs: 1,
    deadlineOverrunMs: 0,
    refreshPeriodMs: 8.33,
    datagramCount: 1,
    rowCount: 1,
    byteLength: 100,
    queueHighWater: 1,
    coherent: true,
    endSeen: true,
    authoritativeVisualChange: true,
    reason: 'membership-complete',
  };
}

function frameComplete(
  atMs: number,
  renderSeq: number,
): Extract<TerminalPerfEvent, { kind: 'frame_complete' }> {
  return {
    kind: 'frame_complete',
    completionDisposition: 'latest-submitted',
    atMs,
    renderSeq,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    queuedDisplayFrames: 0,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    pollCount: 0,
    previousPollAtMs: 0,
  };
}

function renderStart(
  atMs: number,
  renderSeq: number,
): Extract<TerminalPerfEvent, { kind: 'render_start' }> {
  return {
    kind: 'render_start',
    atMs,
    renderSeq,
    displayInputSeq: 1,
    predictionInputSeq: 0,
    queuedDisplayFrames: 1,
    wantedAtMs: atMs,
    gate: 'immediate',
    fenceReleasedAtMs: 0,
    fenceReleasedRenderSeq: 0,
    opportunityEnteredAtMs: 0,
    opportunityDelayMs: 0,
    fenceWaitMs: 0,
    opportunityWaitMs: 0,
    refreshPeriodMs: 8.33,
    refreshConfidence01: 1,
  };
}

function sessionStart(atMs: number): Extract<TerminalPerfEvent, { kind: 'session_start' }> {
  return {
    kind: 'session_start',
    atMs,
  };
}
