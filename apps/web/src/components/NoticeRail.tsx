import { type Component, createSignal, type Element, onSettled } from 'solid-js';

/**
 * The one place app-level notices appear: the update banner and a program's
 * open-URL request stack here, top-centred, rather than each fixing its own
 * corner of the screen.
 *
 * The top, because the bottom is where a phone's controls are: the home
 * indicator (the page is `viewport-fit=cover`, and a tap inside that inset is
 * the system's first), the on-screen keyboard, the native keyboard. The rail
 * follows the visual viewport, which the native keyboard scrolls away from the
 * layout viewport a fixed element is placed in; it moves on the viewport's own
 * `resize` and `scroll` events and never otherwise.
 */
const NoticeRail: Component<{ children: Element }> = (props) => {
  const [offsetTop, setOffsetTop] = createSignal(0);

  onSettled(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const sync = (): void => {
      setOffsetTop(viewport.offsetTop);
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  });

  return (
    <div
      class="pointer-events-none fixed inset-x-0 top-0 z-[9999] flex flex-col items-center gap-2 px-4 pt-[max(16px,env(safe-area-inset-top))]"
      style={{ transform: offsetTop() === 0 ? undefined : `translateY(${offsetTop()}px)` }}
    >
      {props.children}
    </div>
  );
};

export default NoticeRail;
