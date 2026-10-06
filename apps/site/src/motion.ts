/**
 * What moves on the home page, loaded once the page has painted.
 *
 * Every state a visitor can see is already in the markup; the modules under
 * `motion/` only say which one shows and when. Nothing here runs while its
 * element is out of view or the tab is hidden. What travels or eases is a
 * transform or an opacity, which the compositor moves on its own; the small
 * pictures that change a character or a colour repaint a few pixels at a time.
 *
 * A reader who asked for reduced motion gets the page at rest: the finished
 * session, the fader mid-way, the first security pane, and working controls.
 */
import { animate } from 'motion';

import { OUTPUT_LATENCY } from './content/latency-model';
import { createLatency } from './latency';
import { playCards } from './motion/cards';
import { onScreen, reducedMotion } from './motion/clock';
import { blink, float } from './motion/loops';
import { playQuestions } from './motion/questions';
import { playArrival } from './motion/reveal';
import { playSecurity } from './motion/security';
import { playSimulator } from './motion/sim';

/**
 * Motion itself, for the blog. Its pages fetch this module as every page does,
 * so they take the library from it (`src/blog/kit/motion.ts`) rather than
 * carry a second copy of it. Only what the home page already uses is named.
 */
export { animate, animateMini, spring } from 'motion';

export { unfold } from './motion/unfold';

const OUTPUT = createLatency(OUTPUT_LATENCY);

/** How long the program in the Claude Code session takes over each of its six moments, in ms. */
const SESSION_MOMENTS = [1300, 1400, 1800, 3600, 1600, 5200] as const;

/** Steps a mock terminal through its session while it is on screen. */
function playSession(terminal: HTMLElement): void {
  if (reducedMotion.matches) {
    terminal.dataset.s = String(SESSION_MOMENTS.length - 1);
    return;
  }
  // The link the screen names. What the program on the machine writes reaches
  // this screen a frame later, and how long a program's output takes on that
  // link is measured, not chosen (`latency.ts`).
  const rtt = Number(terminal.dataset.linkRtt);
  if (!Number.isFinite(rtt)) throw new Error('site: a mock terminal names no link');
  let moment = 0;
  let timer = 0;
  const hold = (): void => {
    timer = window.setTimeout(
      () => {
        moment = (moment + 1) % SESSION_MOMENTS.length;
        terminal.dataset.s = String(moment);
        hold();
      },
      (SESSION_MOMENTS[moment] ?? 0) + OUTPUT.sample(rtt, 0, Math.random),
    );
  };
  onScreen(terminal, (on) => {
    window.clearTimeout(timer);
    if (on) hold();
  });
}

/** How long a copy button says it has copied, in ms. */
const COPIED_HOLD_MS = 1600;
/** The button's answer to the click: a small press that springs back. */
const COPIED = { type: 'spring', visualDuration: 0.25, bounce: 0.4 } as const;

function wireCopy(button: HTMLButtonElement): void {
  const source = button.parentElement?.querySelector('[data-copy-text]');
  if (source === null || source === undefined) {
    throw new Error('site: a copy button has no text beside it');
  }
  const label = button.textContent ?? '';
  let timer = 0;
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(source.textContent ?? '');
    button.textContent = 'Copied';
    if (!reducedMotion.matches) animate(button, { scale: [0.92, 1] }, COPIED);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      button.textContent = label;
    }, COPIED_HOLD_MS);
  });
}

export function startMotion(): void {
  for (const terminal of document.querySelectorAll<HTMLElement>('[data-term]')) {
    playSession(terminal);
  }
  for (const root of document.querySelectorAll<HTMLElement>('[data-sec]')) playSecurity(root);
  for (const root of document.querySelectorAll<HTMLElement>('[data-sim]')) playSimulator(root);
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    wireCopy(button);
  }
  if (reducedMotion.matches) return;
  playCards();
  playArrival();
  playQuestions();
  for (const caret of document.querySelectorAll<HTMLElement>('[data-sp-caret], [data-t-caret]')) {
    blink(caret);
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-float]')) float(element);
  // The shader pictures replace their stills from a worker of their own.
  void import('./gfx/client').then(({ startGraphics }) => startGraphics());
}
