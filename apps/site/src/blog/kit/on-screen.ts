/**
 * Calls `change` whenever `element` starts or stops being on screen: in the
 * viewport of a visible tab. A figure that plays by itself plays only then.
 *
 * The landing page has the same rule in `motion/clock.ts`. This is the blog's
 * own copy: a module the two shared would become a chunk of its own, and the
 * landing page would fetch one more file for it.
 */
export function onScreen(element: Element, change: (on: boolean) => void): () => void {
  let inView = false;
  let on = false;
  const settle = (): void => {
    const next = inView && document.visibilityState === 'visible';
    if (next === on) return;
    on = next;
    change(on);
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) inView = entry.isIntersecting;
    settle();
  });
  observer.observe(element);
  document.addEventListener('visibilitychange', settle);
  return () => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', settle);
  };
}
