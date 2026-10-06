/**
 * Motion for the blog: the library the home page moves with, taken from the
 * module every page already fetches (`src/motion.ts`) by a dynamic import, so
 * the blog adds no copy of it and the home page's files stay as they are.
 *
 * A page's own moves await `loadMotion()`. A figure is mounted only once it
 * has resolved (`mount.ts`), so inside one `motion()` answers at once.
 *
 * The rule the home page keeps holds here: what plays unprompted or repeats is
 * `animateMini`, which hands the browser a whole animation and asks for no
 * frames; `animate` is for a spring a reader causes, and ends when it settles.
 */
export type Motion = Pick<typeof import('../../motion'), 'animate' | 'animateMini' | 'spring'>;

let loading: Promise<Motion> | null = null;

let loaded: Motion | null = null;

/**
 * Each name is taken by itself: a module taken whole makes the bundler build
 * an object of everything it exports, which the home page would then carry.
 */
export function loadMotion(): Promise<Motion> {
  loading ??= import('../../motion').then(({ animate, animateMini, spring }) => {
    loaded = { animate, animateMini, spring };

    return loaded;
  });

  return loading;
}

/** Motion, where it is known to have loaded: inside a mounted figure. */
export function motion(): Motion {
  if (loaded === null) throw new Error('blog: a figure moved before Motion had loaded');

  return loaded;
}

/** Whether the reader asked for less motion; a figure then shows a change without easing it. */
export function prefersStillness(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Entrances and fades: decelerating, with almost no tail. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Something a reader pressed or caused: quick, with a little life. */
export const TOUCH = { type: 'spring', visualDuration: 0.22, bounce: 0.3 } as const;

/** Something arriving or taking a new place. */
export const SETTLE = { visualDuration: 0.5, bounce: 0.16 } as const;

/**
 * Lights `element` in `tint` and lets it go. A reader who asked for less
 * motion sees the tint hold and leave at once, the same information unmoved.
 */
export function flash(element: Element, tint: string, clear: string, seconds: number): void {
  const still = prefersStillness();
  motion().animateMini(
    element,
    { backgroundColor: still ? [tint, tint, clear] : [tint, clear] },
    still
      ? { duration: seconds * 0.6, times: [0, 0.999, 1], ease: 'linear' }
      : { duration: seconds, ease: EASE_OUT },
  );
}

/** Something new in its place: it rises a few pixels as it appears. */
export function arrive(element: Element): void {
  if (prefersStillness()) return;

  const library = motion();
  library.animateMini(
    element,
    { opacity: [0, 1], transform: ['translateY(-6px)', 'translateY(0px)'] },
    { type: library.spring, ...SETTLE },
  );
}

/**
 * The places of `list`'s children now, to be handed to `settle` after the
 * list has changed: each child that is still there then glides from where it
 * was to where it is.
 */
export function places(list: Element): Map<Element, number> {
  const tops = new Map<Element, number>();

  for (const child of list.children) tops.set(child, child.getBoundingClientRect().top);

  return tops;
}

export function settle(list: Element, before: ReadonlyMap<Element, number>): void {
  if (prefersStillness()) return;

  const library = motion();

  for (const child of list.children) {
    const was = before.get(child);

    if (was === undefined) {
      arrive(child);
      continue;
    }

    const moved = was - child.getBoundingClientRect().top;

    if (moved === 0) continue;

    library.animateMini(
      child,
      { transform: [`translateY(${moved}px)`, 'translateY(0px)'] },
      { type: library.spring, ...SETTLE },
    );
  }
}
