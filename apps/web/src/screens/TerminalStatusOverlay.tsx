import { type Component, createEffect, createSignal, onCleanup, Show } from 'solid-js';

import {
  RECONNECT_ESCAPE_REVEAL_MS,
  TERMINAL_SUCCESS_VISIBLE_MS,
  type TerminalStage,
  type TerminalStatusMode,
  terminalStatusCopyStage,
} from '../terminal/status-presentation';

interface Props {
  readonly deviceName: string;
  readonly mode: TerminalStatusMode;
  readonly stage: TerminalStage;
  readonly status: string;
  onRetry(): void;
}

const TerminalStatusOverlay: Component<Props> = (props) => {
  const copy = () => stageCopy(props.stage, props.mode, props.deviceName);
  // A progress overlay that does not resolve must still be escapable. Revealed
  // on a timer rather than at once, so a reconnect that succeeds inside its own
  // backoff cycle never flashes controls at someone who did not need them.
  const [escapeVisible, setEscapeVisible] = createSignal(false);
  createEffect(
    () => props.mode,
    (mode) => {
      setEscapeVisible(false);
      if (mode !== 'progress') return;
      const timer = setTimeout(() => setEscapeVisible(true), RECONNECT_ESCAPE_REVEAL_MS);
      onCleanup(() => clearTimeout(timer));
    },
  );
  // An error always offers the way out; a long progress state earns it.
  const showControls = () => props.mode === 'error' || escapeVisible();
  const [successVisible, setSuccessVisible] = createSignal(true);
  createEffect(
    () => props.mode,
    (mode) => {
      setSuccessVisible(true);
      if (mode !== 'success') return;
      const timer = setTimeout(() => setSuccessVisible(false), TERMINAL_SUCCESS_VISIBLE_MS);
      onCleanup(() => clearTimeout(timer));
    },
  );

  return (
    <Show
      when={
        props.mode !== 'hidden' &&
        props.status.length > 0 &&
        (props.mode !== 'success' || successVisible())
      }
    >
      <div
        id="terminal-status-overlay"
        class={[
          'absolute inset-0 z-10 flex items-center justify-center p-6',
          {
            'pointer-events-none': !showControls(),
            // The only mode with a scrim, because it is the only one that is a
            // dialog: the others are notices over a grid that is already live.
            'bg-black/50': props.mode === 'error',
          },
        ]}
        role={props.mode === 'error' ? 'alert' : 'status'}
        aria-live={props.mode === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <div
          class={[
            'flex w-full max-w-[340px] flex-col items-center gap-1 rounded-lg border border-solid px-[22px] py-5 text-center shadow-over backdrop-blur-xl',
            {
              'border-line2 bg-panel/92 text-body': props.mode !== 'error',
              'border-badline bg-panel/95 text-badink': props.mode === 'error',
            },
          ]}
        >
          <div
            class={[
              'mb-2 grid h-9 w-9 place-items-center rounded-full border border-solid',
              {
                'border-line2 bg-raised text-body': props.mode === 'progress',
                'border-okline bg-oksoft text-ok': props.mode === 'success',
                'border-badline bg-badsoft font-semibold text-bad': props.mode === 'error',
              },
            ]}
            aria-hidden="true"
          >
            <Show when={props.mode === 'progress'}>
              <span class="spinner h-3.5 w-3.5" />
            </Show>
            <Show when={props.mode === 'success'}>
              <svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="m5 10.5 3.1 3L15 6.75"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </Show>
            <Show when={props.mode === 'error'}>
              <span class="text-[17px] leading-none">!</span>
            </Show>
          </div>

          {/* The card fits its copy rather than reserving room for the longest
              of it. A fixed two lines held every state to one height, but the
              short ones then carried a blank line along the bottom edge, and
              centring the text in that space only traded the gap for the text
              drifting away from the mark above it.

              What actually has to stay still is the card DURING a connection,
              and there the machine's name is a constant — so the three
              progress details are written within a few characters of each
              other, which puts them on the same side of the wrap for any name.
              Connected and the errors are separate moments, and an error
              changes the card's shape anyway by adding a control. */}
          {/* The title is the one sentence that names the moment, so it takes
              the serif the wordmark wears; the detail under it is the fact,
              and stays in the UI face. */}
          <p class="card-title min-h-[1lh]">{copy().title}</p>
          <p class="mt-[3px] max-w-[32rem] text-[13px] leading-[1.5] text-meta">{copy().detail}</p>

          {/* Retry only. The way back is the arrow in the header, which is
              where it is on every other screen; a second one inside the card
              made the card look like a decision when there is only one thing
              to decide. */}
          <Show when={showControls()}>
            <div class="mt-[14px] flex w-full">
              <button type="button" class="btn-primary flex-1" onClick={props.onRetry}>
                Retry
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default TerminalStatusOverlay;

interface StageCopy {
  readonly title: string;
  readonly detail: string;
}

/**
 * Everything the card says, as one table.
 *
 * Title and detail are returned together because their failure mode is drift:
 * written apart, the detail becomes the title again in more words — which is
 * what "Securing connection / Negotiating a secure route to mbp." was. The
 * title names what is happening; the detail carries the one fact the title
 * cannot, and never restates it.
 *
 * The four handshake stages share a TITLE and differ in their DETAIL. Which
 * phase a slow connect is stuck in is real information — a route that will not
 * negotiate is a different problem from a shell that will not start — so it is
 * kept. What is not kept is rewriting the whole card three times in under a
 * second: the heading stays put and says a terminal is opening, and the line
 * beneath it advances. Progress belongs on one line, not on two that leapfrog
 * each other.
 *
 * Nothing here reads the status line. That string is assembled for diagnosis
 * ("mbp · Reconnecting · Signaling reconnecting"), and two branches used to
 * fall through to it.
 */
function stageCopy(stage: TerminalStage, mode: TerminalStatusMode, deviceName: string): StageCopy {
  const name = deviceName.length > 0 ? deviceName : 'your machine';

  if (mode === 'error') {
    // An error says what broke and what the one visible control will do. The
    // two are genuinely different situations: a session that was up and went
    // away, and one that never came up at all.
    return stage === 'disconnected'
      ? {
          title: 'Connection lost',
          detail: `The link to ${name} could not be restored. Retry to start a new session.`,
        }
      : {
          title: 'Could not connect',
          detail: `Merkur could not reach ${name}. Check that it is awake and online.`,
        };
  }

  switch (terminalStatusCopyStage(stage, mode)) {
    // Thirty, twenty-six and twenty-eight characters plus the name: close
    // enough that no machine name puts one of them on a different number of
    // lines from the others, which is what keeps the card still while a
    // connection walks through all three.
    case 'signaling':
      return { title: 'Connecting', detail: `Negotiating a secure route to ${name}.` };
    case 'connecting':
    case 'authenticating':
      return { title: 'Connecting', detail: `Opening a remote shell on ${name}.` };
    case 'first-frame':
      return { title: 'Connecting', detail: `Restoring the display from ${name}.` };
    case 'reconnecting':
      // The most valuable sentence in the set, and the only one people read to
      // the end: what they were doing is not lost. The machine is not named
      // because the header already names it and the length is needed here.
      return {
        title: 'Reconnecting',
        detail: 'Your shell is still running. Input resumes as soon as the link is back.',
      };
    case 'connected':
      // Written to the same length as the three above it, so the success flash
      // that ends a connection is the last frame of a card that never moved
      // rather than one that shrinks a line on its way out.
      return { title: 'Connected', detail: `Your shell on ${name} is ready for input.` };
    default:
      return { title: 'Preparing', detail: `Getting ready to open a terminal on ${name}.` };
  }
}
