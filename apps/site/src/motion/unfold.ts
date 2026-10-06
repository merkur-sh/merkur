/**
 * A `<details>` on springs (Motion): a question on the home page, a tangent in
 * a post.
 *
 * Without this it opens and closes at once, and that is what a reader who
 * asked for reduced motion keeps. With it, its height follows a spring, what
 * it holds comes into focus as the room for it opens, and a close plays back
 * before the element is closed. The `open` attribute stays the truth: it is
 * set first on the way open and last on the way shut, so the address, the
 * keyboard and the analytics see an ordinary `<details>`.
 *
 * What moves is handed to the browser whole (`animateMini`) and wiped from the
 * element when it lands, so a settled one carries no style of its own and
 * reflows like any other.
 */
import { animateMini, spring } from 'motion';

type Playing = ReturnType<typeof animateMini>;

/** Opening has a little life in it; closing only gets out of the way. */
const OPEN = { visualDuration: 0.46, bounce: 0.22 } as const;

const SHUT = { visualDuration: 0.3, bounce: 0 } as const;

const GLIDE = [0.23, 1, 0.32, 1] as const;

/** How a part that turns with the fold gets there: on the fold's spring, or at once. */
export type Pace =
  | { readonly type: 'spring'; readonly visualDuration: number; readonly bounce: number }
  | { readonly duration: 0 };

/** Takes what an animation left on `element` back off it. */
export function wipe(element: HTMLElement, ...properties: string[]): void {
  for (const property of properties) element.style.removeProperty(property);
}

/**
 * Plays `details` open and shut; `body` is what it holds under `summary`.
 * `follow` is for a part that turns with it: it is told which way, and the
 * spring to take there, or no time at all when there is nothing to play.
 */
export function unfold(
  details: HTMLDetailsElement,
  summary: HTMLElement,
  body: HTMLElement,
  follow?: (open: boolean, at: Pace) => void,
): void {
  // The height it is given is its whole box.
  details.style.boxSizing = 'border-box';

  let expanded = details.open;
  let height: Playing | null = null;

  if (expanded) follow?.(true, { duration: 0 });

  const move = (to: boolean): void => {
    const fresh = to && !details.open;
    expanded = to;
    height?.stop();
    const from = details.offsetHeight;
    details.style.height = '';

    if (to) details.open = true;

    // While it closes it is still `open`, so what shows its state is told on its own.
    details.toggleAttribute('data-closing', !to);
    const open = details.offsetHeight;
    const target = to ? open : open - body.offsetHeight;
    details.style.overflow = 'clip';

    const settle = to ? OPEN : SHUT;

    const playing = animateMini(
      details,
      { height: [`${from}px`, `${target}px`] },
      { type: spring, ...settle },
    );

    height = playing;
    follow?.(to, { type: 'spring', ...settle });

    if (to) {
      const focus = animateMini(
        body,
        fresh
          ? {
              opacity: [0, 1],
              transform: ['translateY(-12px)', 'translateY(0px)'],
              filter: ['blur(6px)', 'blur(0px)'],
            }
          : { opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' },
        { duration: 0.55, delay: fresh ? 0.06 : 0, ease: GLIDE },
      );

      void focus.finished.then(() => {
        if (expanded) wipe(body, 'opacity', 'transform', 'filter');
      });
    } else {
      animateMini(
        body,
        { opacity: 0, transform: 'translateY(-8px)', filter: 'blur(4px)' },
        { duration: 0.2, ease: 'easeIn' },
      );
    }

    void playing.finished.then(() => {
      // A later click took over before this one settled.
      if (height !== playing) return;

      height = null;

      if (!to) {
        details.open = false;
        details.removeAttribute('data-closing');
        wipe(body, 'opacity', 'transform', 'filter');
      }

      wipe(details, 'height', 'overflow');
    });
  };

  summary.addEventListener('click', (event) => {
    event.preventDefault();
    move(!expanded);
  });
  // Opened from outside, by the address: there is nothing to play, only to agree with.
  details.addEventListener('toggle', () => {
    if (height !== null || details.open === expanded) return;

    expanded = details.open;
    follow?.(expanded, { duration: 0 });
  });
}
