import { animate } from 'motion';
import { type Component, onSettled } from 'solid-js';

import { fadeTransition } from '../lib/motion';

/**
 * A new build is installed and waiting. Reload hands the page to it; from the
 * tap until the page reloads the button stays where it is, disabled and saying
 * so, rather than looking as if the tap never landed.
 */
const SwUpdateBanner: Component<{ applying: boolean; onReload(): void }> = (props) => {
  let bannerEl!: HTMLDivElement;

  onSettled(() => {
    // Fades, never slides: the button is the hit target from its first frame,
    // and a tap made while it was still travelling would land where it had been.
    const bannerMotion = animate(bannerEl, { opacity: [0, 1] }, fadeTransition(0.12));
    return () => bannerMotion.stop();
  });

  return (
    <div
      ref={bannerEl}
      role="status"
      data-sw-update-banner=""
      class="pointer-events-auto flex items-center gap-3 rounded-sm border border-solid border-line2 bg-raised py-[7px] pl-[14px] pr-[7px] text-[13px] text-ink shadow-float"
    >
      <span>{props.applying ? 'Updating…' : 'Update ready. Reload to apply.'}</span>
      <button
        type="button"
        class="btn-primary btn-sm"
        disabled={props.applying}
        aria-busy={props.applying ? 'true' : 'false'}
        onClick={() => props.onReload()}
      >
        Reload
      </button>
    </div>
  );
};

export default SwUpdateBanner;
