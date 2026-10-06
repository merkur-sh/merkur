/**
 * What moves on a page of the blog outside its figures: the marker beside "On
 * this page", a tangent opening, a control answering a press. `page.ts` loads
 * this after the page has painted; every state it moves between is already
 * the markup's and the stylesheet's.
 *
 * A block rising as it is scrolled to is the home page's own doing: the
 * templates mark it `data-reveal`, and the module that moves every page
 * (`src/motion.ts`) finds it.
 *
 * A reader who asked for less motion gets the marker and plain tangents,
 * unmoved.
 */
import { type Motion, prefersStillness, SETTLE, TOUCH } from './kit/motion';

/** What answers a press. */
const PRESSED = '.fig-button, .packet, .code-copy';

/** Where the marker goes when the section being read changes. */
type Follow = (link: HTMLElement | null) => void;

/** The marker beside the contents: one bar that travels to the section being read. */
function followContents(animate: Motion['animate'], list: HTMLElement): Follow {
  const bar = list.querySelector<HTMLElement>('.toc-bar');

  if (bar === null) throw new Error('blog: the contents have no marker');

  // From here the bar says which section; the links' own edges stop saying it.
  list.toggleAttribute('data-marked', true);
  let shown = false;

  return (link) => {
    if (link === null) {
      shown = false;
      animate(bar, { opacity: 0 }, { duration: 0.2 });

      return;
    }

    // Its first place is where it appears; after that it travels.
    animate(
      bar,
      { y: link.offsetTop, height: link.offsetHeight, opacity: 1 },
      shown && !prefersStillness() ? { type: 'spring', ...SETTLE } : { duration: 0 },
    );
    shown = true;
  };
}

/** A control gives under a press and springs back. Figures draw theirs later, so the page listens for all of them. */
function answerPresses(animate: Motion['animate']): void {
  document.addEventListener('pointerdown', (event) => {
    const control = event.target instanceof Element ? event.target.closest(PRESSED) : null;

    if (!(control instanceof HTMLButtonElement) || control.disabled) return;

    animate(control, { scale: 0.94 }, TOUCH);

    const release = (): void => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      animate(control, { scale: 1 }, TOUCH);
    };

    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  });
}

/** Starts the page's moves; resolves to what follows the section being read, if the page has contents. */
export async function startMoves(): Promise<Follow | null> {
  const { animate, unfold } = await import('../motion');
  const contents = document.querySelector<HTMLElement>('.toc-links');
  const follow = contents === null ? null : followContents(animate, contents);

  if (prefersStillness()) return follow;

  answerPresses(animate);

  for (const tangent of document.querySelectorAll<HTMLDetailsElement>('details.tangent')) {
    const summary = tangent.querySelector('summary');
    const body = tangent.querySelector<HTMLElement>('.tangent-body');

    if (summary === null || body === null) throw new Error('blog: a tangent is missing a part');

    unfold(tangent, summary, body);
  }

  return follow;
}
