/**
 * When things on the page may move: only on screen, and on a clock that stops
 * with them.
 */
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** Easing curves, as Motion takes them. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_GLIDE = [0.45, 0.05, 0.55, 0.95] as const;

/**
 * Calls `change` whenever `element` starts or stops being on screen: in the
 * viewport of a visible tab.
 */
export function onScreen(element: Element, change: (on: boolean) => void, threshold = 0): void {
  let inView = false;
  let on = false;
  const settle = (): void => {
    const next = inView && document.visibilityState === 'visible';
    if (next === on) return;
    on = next;
    change(on);
  };
  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) inView = entry.isIntersecting;
      settle();
    },
    { threshold },
  ).observe(element);
  document.addEventListener('visibilitychange', settle);
}

export interface Agenda {
  /** Runs `task` once `ms` of running time from now have passed. */
  at(ms: number, task: () => void): void;
  /** Stops the clock; what is due stays due. */
  pause(): void;
  resume(): void;
  /** Forgets everything still due. */
  clear(): void;
}

/**
 * A list of things to do at given times, on a clock that only runs while it
 * is resumed: one timer for the next task, none while paused or empty. It
 * starts paused.
 */
export function createAgenda(): Agenda {
  let due: { at: number; task: () => void }[] = [];
  let elapsed = 0;
  let since: number | null = null;
  let timer = 0;

  const now = (): number => (since === null ? elapsed : elapsed + performance.now() - since);
  const arm = (): void => {
    window.clearTimeout(timer);
    const next = due[0];
    if (since === null || next === undefined) return;
    timer = window.setTimeout(run, Math.max(0, next.at - now()));
  };
  const run = (): void => {
    const time = now();
    const ready = due.filter((entry) => entry.at <= time);
    due = due.filter((entry) => entry.at > time);
    for (const entry of ready) entry.task();
    arm();
  };

  return {
    at(ms, task) {
      due.push({ at: now() + ms, task });
      due.sort((a, b) => a.at - b.at);
      arm();
    },
    pause() {
      if (since === null) return;
      elapsed = now();
      since = null;
      window.clearTimeout(timer);
    },
    resume() {
      if (since !== null) return;
      since = performance.now();
      arm();
    },
    clear() {
      due = [];
      window.clearTimeout(timer);
    },
  };
}
