/**
 * Figure 1: two terminals that ran the same suite with the lid closed. One
 * replays what it buffered; the other is sent the screen as it is now.
 */
import type { JSX } from '@solidjs/web';
import { createSignal, onCleanup } from 'solid-js';

import { arrive, flash } from '../../../../../src/blog/kit/motion';
import { Rows, Segments } from '../../../../../src/blog/kit/terminal';
import {
  AFTER,
  AWAY,
  BEFORE,
  bytesAway,
  formatBytes,
  formatSeconds,
  type Row,
  replayedLines,
  replayRows,
  replaySeconds,
  SCREEN,
  screenSeconds,
  shownReplayMs,
} from './reconnect.model';

/** How long after Reconnect the screen arrives in the figure, in ms. */
const SCREEN_ARRIVES_MS = 200;

/** The rows of a screen that has just arrived are lit, and let go over this long, in seconds. */
const LIT_SECONDS = 1.1;

const LIT = 'rgba(203, 166, 247, 0.16)';

const UNLIT = 'rgba(203, 166, 247, 0)';

/** The lid was closed for two hours when the figure opens. */
const AWAY_AT_FIRST = 4;

type Phase = 'idle' | 'replay' | 'done';

type Link = 'down' | 'busy' | 'up';

/** What one of the two terminals shows at a moment: its rows and the line under them. */
interface PaneView {
  readonly rows: readonly Row[];
  readonly status: string;
  readonly link: Link;
}

function Pane(props: {
  readonly title: string;
  readonly note: string;
  readonly rows: readonly Row[];
  readonly status: string;
  readonly link: Link;
  /** Takes the terminal's element, for what the figure moves in it. */
  readonly ref: (pane: HTMLDivElement) => void;
}): JSX.Element {
  return (
    <div class="ft" ref={props.ref}>
      <div class="ft-head">
        {props.title}
        <span class="ft-note">{props.note}</span>
      </div>
      <div class="ft-rows">
        <Rows rows={props.rows}>
          {(row) => (
            <div class="ft-row">
              <Segments line={row().line} />
              {row().caret && <span class="ft-caret" />}
            </div>
          )}
        </Rows>
      </div>
      <div class="ft-status" data-link={props.link}>
        <span class="ft-dot" />
        {props.status}
      </div>
    </div>
  );
}

export default function Reconnect(): JSX.Element {
  const [away, setAway] = createSignal(AWAY_AT_FIRST);
  const [phase, setPhase] = createSignal<Phase>('idle');
  /** How much of the replay has been shown, from 0 to 1. */
  const [shown, setShown] = createSignal(0);
  const [arrived, setArrived] = createSignal(false);
  let frame = 0;
  let timers: number[] = [];
  let streamPane: HTMLDivElement | undefined;
  let screenPane: HTMLDivElement | undefined;

  /** The line under a terminal has something new to say. */
  const say = (pane: HTMLDivElement | undefined): void => {
    const status = pane?.querySelector('.ft-status');

    if (status !== null && status !== undefined) arrive(status);
  };

  /** A whole screen has just been drawn: its rows are lit and let go. */
  const light = (pane: HTMLDivElement | undefined): void => {
    for (const row of pane?.querySelector('.ft-rows')?.children ?? []) {
      flash(row, LIT, UNLIT, LIT_SECONDS);
    }
  };

  const stop = (): void => {
    // Nothing is running where the still is rendered, and there is no frame clock there.
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;

    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  };

  onCleanup(stop);

  const rest = (next: number): void => {
    stop();
    setAway(next);
    setPhase('idle');
    setShown(0);
    setArrived(false);
  };

  const reconnect = (): void => {
    if (phase() === 'replay') return;
    stop();
    const duration = shownReplayMs(away());
    const started = performance.now();
    setPhase('replay');
    setShown(0);
    setArrived(false);
    say(streamPane);
    say(screenPane);
    timers.push(
      window.setTimeout(() => {
        setArrived(true);
        light(screenPane);
        say(screenPane);
      }, SCREEN_ARRIVES_MS),
    );

    const tick = (now: number): void => {
      const progress = Math.min(1, (now - started) / duration);
      setShown(progress);

      if (progress < 1) {
        frame = requestAnimationFrame(tick);

        return;
      }

      setPhase('done');
      light(streamPane);
      say(streamPane);
    };

    frame = requestAnimationFrame(tick);
  };

  const stream = (): PaneView => {
    const bytes = bytesAway(away());

    if (phase() === 'idle')
      return { rows: BEFORE, status: 'disconnected · lid closed', link: 'down' };

    if (phase() === 'replay') {
      return {
        rows: replayRows(Math.round(shown() * replayedLines(away()))),
        status: `replaying ${formatBytes(bytes * shown())} of ${formatBytes(bytes)}`,
        link: 'busy',
      };
    }

    return {
      rows: AFTER,
      status: `caught up after ${formatSeconds(replaySeconds(away()))} · ${formatBytes(bytes)} replayed`,
      link: 'up',
    };
  };

  const screen = (): PaneView => {
    if (phase() === 'idle')
      return { rows: BEFORE, status: 'disconnected · lid closed', link: 'down' };

    if (!arrived()) return { rows: BEFORE, status: 'reconnecting…', link: 'busy' };

    return {
      rows: AFTER,
      status: `caught up after ${formatSeconds(screenSeconds())} · one screen, ${formatBytes(SCREEN)}`,
      link: 'up',
    };
  };

  return (
    <>
      <div class="ft-pair">
        <Pane
          title="Byte stream"
          note="replays what it buffered"
          rows={stream().rows}
          status={stream().status}
          link={stream().link}
          ref={(pane) => {
            streamPane = pane;
          }}
        />
        <Pane
          title="Merkur"
          note="sends the current screen"
          rows={screen().rows}
          status={screen().status}
          link={screen().link}
          ref={(pane) => {
            screenPane = pane;
          }}
        />
      </div>
      <div class="fig-controls">
        <button
          type="button"
          class="fig-button"
          disabled={phase() === 'replay'}
          onClick={reconnect}
        >
          Reconnect
        </button>
        <button
          type="button"
          class="fig-button"
          onClick={() => {
            rest(away());
          }}
        >
          Reset
        </button>
        <label class="fig-range">
          Away for
          <input
            type="range"
            min="0"
            max="4"
            step="1"
            value="4"
            onInput={(event) => rest(Number(event.currentTarget.value))}
          />
          <span class="fig-range-value" data-wide>
            {AWAY[away()]?.[0]}
          </span>
        </label>
        <span class="fig-readout">{formatBytes(bytesAway(away()))} to replay</span>
      </div>
    </>
  );
}
